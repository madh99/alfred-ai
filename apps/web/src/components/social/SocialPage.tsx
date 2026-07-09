'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import type { InterestTopicItem, SocialAssetItem, SocialChannelItem, SocialContentItem } from '@/lib/alfred-client';

const PLATFORM_ICON: Record<string, string> = {
  youtube: '▶️', instagram: '📸', facebook: '👥', threads: '🧵',
  x: '𝕏', telegram_channel: '✈️', rest: '🌐',
};

const MODE_LABEL: Record<string, string> = {
  suggest: 'Vorschlagen', approve: 'Mit Freigabe', autonomous: 'Autonom',
};

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-300',
  scheduled: 'bg-blue-500/20 text-blue-300',
  approved: 'bg-emerald-500/20 text-emerald-300',
  published: 'bg-green-600/20 text-green-300',
  failed: 'bg-red-500/20 text-red-300',
  rejected: 'bg-gray-600/20 text-gray-500',
  idea: 'bg-purple-500/20 text-purple-300',
  publishing: 'bg-amber-500/20 text-amber-300',
};

// ── v964 — Zeiten LOKAL anzeigen (vorher roher UTC-ISO-String: „Mo 18:00"
// erschien als 16:00Z und stiftete Slot-Verwirrung) ──
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('de-AT', {
    weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function fmtRelative(iso: string): string {
  const diffMin = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  const abs = Math.abs(diffMin);
  const txt = abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} Std.` : `${Math.round(abs / 1440)} Tagen`;
  return diffMin >= 0 ? `in ${txt}` : `vor ${txt}`;
}

/** ISO → Wert für <input type="datetime-local"> (lokale Zeit). */
function toLocalInput(iso?: string): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** v1000 — Seiten der Social-UI (vorher eine einzige Scroll-Seite). */
type QueueTab = 'decisions' | 'plan' | 'history' | 'channels' | 'comments' | 'analytics';

const PAGE_LABEL: Record<QueueTab, string> = {
  decisions: '📥 Entscheidungen', plan: '🗓 Plan', history: '🗂 Verlauf',
  channels: '📡 Kanäle', comments: '💬 Kommentare', analytics: '📊 Analytics',
};

/** v1015 — Kanal-Wizard: Pflichtfelder + Secrets-Hinweise je Plattform. */
const PLATFORM_WIZARD: Record<string, { label: string; fields: Array<{ key: string; label: string; placeholder: string }>; hint: string }> = {
  telegram_channel: { label: '✈️ Telegram-Kanal', fields: [{ key: 'chat_id', label: 'Chat-ID / @handle', placeholder: '@meinkanal' }], hint: 'Der Bot muss Kanal-Admin sein (globaler Bot-Token oder Secret TELEGRAM_BOT_TOKEN in der ENV-Stage).' },
  rest: { label: '🌐 Eigene Plattform (REST)', fields: [{ key: 'base_url', label: 'Basis-URL', placeholder: 'https://meine-site.tld' }, { key: 'publish_path', label: 'Publish-Pfad (optional)', placeholder: '/api/posts' }], hint: 'Secret API_TOKEN in der ENV-Stage des Kanals; body_template/url_template per Chat feinjustierbar.' },
  instagram: { label: '📸 Instagram', fields: [{ key: 'ig_user_id', label: 'IG-User-ID', placeholder: '17841…' }], hint: 'Secret META_ACCESS_TOKEN (ENV-Stage social). Für generierte Bilder zusätzlich public_media konfigurieren (per Chat) — sonst scheitern Bild-Posts.' },
  facebook: { label: '👥 Facebook-Page', fields: [{ key: 'page_id', label: 'Page-ID', placeholder: '1176…' }], hint: 'Secret META_ACCESS_TOKEN (ENV-Stage social); Meta-App muss live sein.' },
  threads: { label: '🧵 Threads', fields: [{ key: 'threads_user_id', label: 'Threads-User-ID', placeholder: '…' }], hint: 'Secret THREADS_ACCESS_TOKEN oder META_ACCESS_TOKEN (ENV-Stage social).' },
  x: { label: '𝕏 X', fields: [], hint: 'Secrets X_ACCESS_TOKEN + X_REFRESH_TOKEN + X_CLIENT_ID (OAuth2); für Bild-Posts zusätzlich X_CONSUMER_KEY/-SECRET + X_OAUTH1_ACCESS_TOKEN/-SECRET (v1.1-Upload). config.max_posts_per_month passend zum Credit-Kontingent setzen.' },
  bluesky: { label: '🦋 Bluesky', fields: [{ key: 'handle', label: 'Handle', placeholder: 'meinname.bsky.social' }], hint: 'Secret BLUESKY_APP_PASSWORD (App-Passwort aus den Bluesky-Einstellungen — NIE das Konto-Passwort). Bilder werden direkt hochgeladen, Links sind klickbar.' },
  youtube: { label: '▶️ YouTube', fields: [], hint: 'OAuth-Secrets YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN (ENV-Stage social).' },
};

/** v1006 — Sprachen für die Kanal-Einstellungen (Code → Anzeigename). */
const LANGS: Array<[string, string]> = [
  ['de', 'Deutsch'], ['en', 'Englisch'], ['fr', 'Französisch'], ['it', 'Italienisch'],
  ['es', 'Spanisch'], ['pt', 'Portugiesisch'], ['nl', 'Niederländisch'], ['pl', 'Polnisch'],
  ['tr', 'Türkisch'], ['hr', 'Kroatisch'],
];

/** v996 — Familien-Schlüssel wie im Kern (content-studio.familyKey): config.family vor Projekt-Bindung. */
function familyKeyOf(c: SocialChannelItem): string | null {
  const fam = c.config.family;
  if (typeof fam === 'string' && fam.trim()) return `family:${fam.trim().toLowerCase()}`;
  if (c.projectId) return `project:${c.projectId}`;
  return null;
}

/** v996 — stabile Story-Farbe (gleiche Story = gleiche Farbe im Familien-Raster). */
const STORY_PALETTE = [
  'bg-sky-500/25 text-sky-200 border-sky-500/40',
  'bg-amber-500/25 text-amber-200 border-amber-500/40',
  'bg-emerald-500/25 text-emerald-200 border-emerald-500/40',
  'bg-fuchsia-500/25 text-fuchsia-200 border-fuchsia-500/40',
  'bg-rose-500/25 text-rose-200 border-rose-500/40',
  'bg-indigo-500/25 text-indigo-200 border-indigo-500/40',
  'bg-teal-500/25 text-teal-200 border-teal-500/40',
  'bg-orange-500/25 text-orange-200 border-orange-500/40',
];

/** v992 — Kommentar aus social_comments (Antwort-Workflow new → replied|ignored). */
interface SocialCommentItem {
  id: string; channelId: string; itemId?: string;
  author?: string; text: string; status: 'new' | 'replied' | 'ignored';
  replyText?: string; remoteCreatedAt?: string; createdAt: string;
}

/** v967 — Mini-Verlaufslinie (SVG) für Kanal-Metriken. */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const w = 120; const h = 26;
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 3) - 1).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} className="text-emerald-400">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function SocialPage() {
  const { client } = useConfig();
  const [channels, setChannels] = useState<SocialChannelItem[]>([]);
  const [pending, setPending] = useState<SocialContentItem[]>([]);
  const [history, setHistory] = useState<SocialContentItem[]>([]);
  const [calendar, setCalendar] = useState<SocialContentItem[]>([]);
  const [publishedRecent, setPublishedRecent] = useState<SocialContentItem[]>([]);
  const [metrics, setMetrics] = useState<Record<string, Array<{ kind: string; value: number; date: string; itemId?: string }>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  // v1000 — Seiten-Navigation (Tabs statt einer Scroll-Seite) + Kanal-Filter
  const [page, setPage] = useState<QueueTab>('decisions');
  const [channelFilter, setChannelFilter] = useState<string>('');
  // v1000 — Bulk-Auswahl (Mehrfach-Freigabe) + fehlgeschlagene Items für die Triage
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [failedItems, setFailedItems] = useState<SocialContentItem[]>([]);
  // v1001 — Detail-Sheet (großes Bild, voller Text, Story-Geschwister, alle Aktionen)
  const [detailId, setDetailId] = useState<string | null>(null);
  // v1014 — Bild-Bibliothek (Basis-Bilder zur Wiederverwendung)
  const [assets, setAssets] = useState<SocialAssetItem[]>([]);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [assetsOpen, setAssetsOpen] = useState(false);
  // v1017 — Lightbox + Motiv-Editor der Bild-Bibliothek
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [motifEditId, setMotifEditId] = useState<string | null>(null);
  const [motifDraft, setMotifDraft] = useState('');
  // v1015 — Kanal-Wizard
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizard, setWizard] = useState<{ platform: string; name: string; project: string; mode: string; publishMode: string; persona: string; fields: Record<string, string> }>(
    { platform: 'telegram_channel', name: '', project: '', mode: 'approve', publishMode: 'api', persona: '', fields: {} });
  // v964 — Umterminieren (Inline-Datepicker je Item)
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [rescheduleAt, setRescheduleAt] = useState<string>('');
  // v948 — Bild-Vorschauen: Blob-URLs je Item (Auth via Bearer, daher kein direktes <img src>)
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  // v955 — Inline-Editor (Korrektur + optionale Lektion, aus der der Kanal lernt)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ title: string; body: string; hashtags: string; lesson: string }>({ title: '', body: '', hashtags: '', lesson: '' });
  // v991 — „Verbessern"-Panel: Anweisung → Text-Überarbeitung ODER Bild-Neuerzeugung
  const [improvingId, setImprovingId] = useState<string | null>(null);
  const [improveText, setImproveText] = useState('');
  // v992 — Kommentare (Antwort-Workflow; reply geht LIVE)
  const [comments, setComments] = useState<SocialCommentItem[]>([]);
  const [commentStatusFilter, setCommentStatusFilter] = useState<'new' | 'replied' | 'ignored'>('new');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  // v965 — Kanal-Einstellungen (Panel je Kanal) + Themen-Verknüpfung
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<{
    persona: string; slots: string; blacklist: string; maxPostsPerDay: number;
    planningHorizonDays: number; generateImages: boolean; imageBudgetTotal: number;
    lessons: string[]; newLesson: string; modelTier: string;
    // v996 — Familien-Playbook (+v999 Traffic-Modus)
    familyRole: 'auto' | 'lead' | 'follow'; familyOffset: string;
    quietFrom: number; quietTo: number; newsdeskThreshold: number; newsdeskMaxPerDay: number;
    trafficMode: 'voll' | 'teaser' | 'auto';
    // v1004 — Bild-Look je Kanal
    imageStyle: string; imageQuality: 'default' | 'low' | 'medium' | 'high';
    imageBranding: string; watermarkOn: boolean; titleOverlayOn: boolean;
    // v1026 — Ecken + Logo-Wasserzeichen (SVG inline in der Config) · v1032 — Logo-Farbe ('' = Original)
    watermarkCorner: string; logoSvg: string; logoCorner: string; logoColor: string;
    // v1041 — Termin-Vorlage (Asset-ID aus der Bibliothek; '' = generieren wie bisher)
    terminImage: string;
    // v1006 — Sprache + Übersetzungen (translate_to nur bei rest-Kanälen wirksam)
    language: string; translateTo: string[];
    // v1007 — IG-Auto-Story beim Lead-Publish · v1008 — IG-Karussells · v1016 — Auto-Reels
    autoStory: boolean; imageCarousel: boolean; autoReel: boolean;
    // v1060 — Reels & Video: Wochen-Cap, CTA, Musik-Bett (v1059), KI-Clips (Stufe 3)
    reelMaxPerWeek: number; reelCtaText: string; reelMusicOn: boolean; reelMusicVolume: string;
    reelAiClips: 0 | 1 | 2; reelAiProvider: 'sora' | 'runway' | 'veo'; reelAiModel: string; aiClipBudget: number;
    // v1066 — Dauer-Branding im Video (TV-Bug): aus|text|logo|both + Ecke
    // v1067 — Anordnung bei Text+Logo (Block/Block+Angleich/getrennt) + Logo-Ecke
    reelWatermark: 'aus' | 'text' | 'logo' | 'both'; reelWatermarkCorner: string;
    reelWatermarkLayout: 'stack' | 'stack_fit' | 'split'; reelWatermarkLogoCorner: string;
    // v1012 — Serien-Formate (wöchentlich wiederkehrend)
    formate: Array<{ slot: string; name: string; anweisung: string }>;
  }>({ persona: '', slots: '', blacklist: '', maxPostsPerDay: 3, planningHorizonDays: 14, generateImages: false, imageBudgetTotal: 30, lessons: [], newLesson: '', modelTier: 'fast',
    familyRole: 'auto', familyOffset: '', quietFrom: 22, quietTo: 6, newsdeskThreshold: 0.85, newsdeskMaxPerDay: 3, trafficMode: 'voll',
    imageStyle: '', imageQuality: 'default', imageBranding: '', watermarkOn: true, titleOverlayOn: false,
    watermarkCorner: 'bottom-right', logoSvg: '', logoCorner: 'bottom-right', logoColor: '', terminImage: '',
    language: 'de', translateTo: [], autoStory: false, imageCarousel: false, autoReel: false,
    reelMaxPerWeek: 2, reelCtaText: '', reelMusicOn: true, reelMusicVolume: '',
    reelAiClips: 0, reelAiProvider: 'sora', reelAiModel: '', aiClipBudget: 8,
    reelWatermark: 'aus', reelWatermarkCorner: 'bottom-right',
    reelWatermarkLayout: 'stack', reelWatermarkLogoCorner: 'top-left', formate: [] });
  const [interestTopics, setInterestTopics] = useState<InterestTopicItem[]>([]);
  const [linkTopicSel, setLinkTopicSel] = useState<string>('');
  // v1024 — Ad-hoc-Story („Story anstoßen"): Stoff → Beiträge auf allen Familien-Kanälen
  const [storyOpen, setStoryOpen] = useState(false);
  const [story, setStory] = useState<{ titel: string; stoff: string }>({ titel: '', stoff: '' });
  // v966 — Composer („Neuer Beitrag") + Crosspost-Ziele je Item
  const [composerOpen, setComposerOpen] = useState(false);
  const [composer, setComposer] = useState<{ channel: string; title: string; body: string; hashtags: string; mediaUrl: string; scheduledAt: string }>(
    { channel: '', title: '', body: '', hashtags: '', mediaUrl: '', scheduledAt: '' });
  const [crosspostId, setCrosspostId] = useState<string | null>(null);
  const [crosspostSel, setCrosspostSel] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const [ch, sched, drafts, approved, published, cal, failed] = await Promise.all([
        client.fetchSocialChannels(),
        client.fetchSocialItems({ status: 'scheduled', limit: 50 }),
        client.fetchSocialItems({ status: 'draft', limit: 50 }),
        client.fetchSocialItems({ status: 'approved', limit: 50 }),
        client.fetchSocialItems({ status: 'published', limit: 100 }),
        client.fetchSocialCalendar(new Date().toISOString(), new Date(Date.now() + 14 * 24 * 3_600_000).toISOString()),
        client.fetchSocialItems({ status: 'failed', limit: 25 }),
      ]);
      setChannels(ch);
      // v964 — auch approved gehört in die Queue (vorher unsichtbar, bis es im Kalender auftauchte)
      const byTime = (a: SocialContentItem, b: SocialContentItem) => (a.scheduledAt ?? '9999').localeCompare(b.scheduledAt ?? '9999');
      setPending([...approved, ...sched, ...drafts].sort(byTime));
      setPublishedRecent(published);
      setCalendar(cal);
      setFailedItems(failed); // v1000 — Probleme gehören in die Triage, nicht in den Verlauf versteckt
      // Metriken der aktiven Kanäle (best-effort)
      const m: typeof metrics = {};
      await Promise.all(ch.filter(c => c.status === 'active').map(async c => {
        m[c.id] = await client.fetchSocialMetrics(c.id).catch(() => []);
      }));
      setMetrics(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  // v964 — Verlauf (published/failed/rejected) erst beim Tab-Wechsel laden
  const loadHistory = useCallback(async () => {
    if (!client) return;
    try {
      const [published, failed, rejected] = await Promise.all([
        client.fetchSocialItems({ status: 'published', limit: 50 }),
        client.fetchSocialItems({ status: 'failed', limit: 25 }),
        client.fetchSocialItems({ status: 'rejected', limit: 25 }),
      ]);
      const ts = (i: SocialContentItem) => i.publishedAt ?? i.scheduledAt ?? i.createdAt;
      setHistory([...published, ...failed, ...rejected].sort((a, b) => ts(b).localeCompare(ts(a))));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => { if (page === 'history') loadHistory(); }, [page, loadHistory]);

  // v992 — Kommentare laden (bei Tab-Wechsel und Filter-Änderung)
  const loadComments = useCallback(async () => {
    if (!client) return;
    try {
      setComments(await client.fetchSocialComments({
        channel: channelFilter || undefined, status: commentStatusFilter,
      }) as SocialCommentItem[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, channelFilter, commentStatusFilter]);

  useEffect(() => { if (page === 'comments') loadComments(); }, [page, loadComments]);

  // v1014 — Bild-Bibliothek laden (beim Aufklappen im Kanäle-Tab)
  const loadAssets = useCallback(async () => {
    if (!client) return;
    try {
      const list = await client.fetchSocialAssets();
      setAssets(list);
      // v1026 — ALLE Thumbnails laden (serverseitig auf 320px verkleinert):
      // der alte 40er-Deckel gegen Voll-PNGs ließ den Rest der Galerie leer
      for (const a of list) {
        if (assetUrls[a.id] !== undefined || !a.basename) continue;
        setAssetUrls(prev => ({ ...prev, [a.id]: '' }));
        client.fetchSocialMediaObjectUrl(a.basename, 320).then(url => {
          if (url) setAssetUrls(prev => ({ ...prev, [a.id]: url }));
        });
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    // assetUrls bewusst nicht in deps (eigene Updates)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => { if (page === 'channels' && assetsOpen) loadAssets(); }, [page, assetsOpen, loadAssets]);

  // v1015 — Kanal anlegen (durch den Skill, alle Leitplanken + Hinweise inklusive)
  async function submitWizard() {
    if (!wizard.name.trim()) { setError('Kanal-Name erforderlich.'); return; }
    const meta = PLATFORM_WIZARD[wizard.platform];
    for (const f of meta?.fields ?? []) {
      if (!f.label.includes('optional') && !(wizard.fields[f.key] ?? '').trim()) {
        setError(`${f.label} erforderlich.`); return;
      }
    }
    await withBusy('wizard', async () => {
      const config: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(wizard.fields)) if (v.trim()) config[k] = v.trim();
      const r = await client!.socialCreateChannel({
        platform: wizard.platform, name: wizard.name.trim(),
        project: wizard.project.trim() || undefined,
        mode: wizard.mode, publish_mode: wizard.publishMode,
        persona: wizard.persona.trim() || undefined,
        config: Object.keys(config).length > 0 ? config : undefined,
      });
      if (!r.success) throw new Error(r.error ?? 'Anlegen fehlgeschlagen');
      if (r.display) setNotice(r.display);
      setWizardOpen(false);
      setWizard(w => ({ ...w, name: '', persona: '', fields: {} }));
      await load();
    });
  }

  async function assetAction(a: SocialAssetItem, action: 'block' | 'unblock' | 'delete' | 'motif' | 'describe' | 'pin' | 'unpin', extra?: { motif?: string }) {
    if (action === 'delete' && !confirm('Basis-Bild endgültig aus der Bibliothek löschen (Datei + Eintrag)?')) return;
    await withBusy(a.id, async () => {
      const r = await client!.socialAssetAction(a.id, action, extra);
      if (!r.success) throw new Error(r.error ?? 'Aktion fehlgeschlagen');
      setMotifEditId(null);
      await loadAssets();
    });
  }

  async function commentAction(c: SocialCommentItem, action: 'reply' | 'ignore' | 'suggest') {
    await withBusy(c.id, async () => {
      const extra = action === 'reply' ? { reply: (replyDrafts[c.id] ?? '').trim() } : undefined;
      if (action === 'reply' && !extra?.reply) throw new Error('Antwort-Text fehlt.');
      const r = await client!.socialCommentAction(c.id, action, extra);
      if (!r.success) throw new Error(r.error ?? 'Aktion fehlgeschlagen');
      if (action === 'suggest') {
        const draft = (r.data as { draft?: string } | undefined)?.draft ?? '';
        setReplyDrafts(d => ({ ...d, [c.id]: draft }));
        return; // nur Entwurf ins Feld — gesendet wird erst per „Antworten"
      }
      if (r.display) setNotice(r.display);
      await loadComments();
    });
  }

  // v948 — Bild-Vorschauen nachladen (erstes image je Item)
  useEffect(() => {
    if (!client) return;
    const items = [...pending, ...calendar, ...history, ...failedItems];
    for (const item of items) {
      if (mediaUrls[item.id] !== undefined) continue;
      const image = item.media?.find(m => m.type === 'image');
      if (!image) continue;
      setMediaUrls(prev => ({ ...prev, [item.id]: '' })); // in-flight-Marker
      client.fetchSocialMediaObjectUrl(image.pathOrUrl).then(url => {
        if (url) setMediaUrls(prev => ({ ...prev, [item.id]: url }));
      });
    }
    // mediaUrls bewusst nicht in deps — sonst Endlosschleife durch eigene Updates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, pending, calendar, history]);

  const channelName = useCallback((id: string) => channels.find(c => c.id === id)?.name ?? id.slice(0, 8), [channels]);

  // v964 — heutige Veröffentlichungen je Kanal (fürs Tages-Limit-Signal)
  const publishedTodayByChannel = useMemo(() => {
    const today = new Date();
    const isToday = (iso?: string) => {
      if (!iso) return false;
      const d = new Date(iso);
      return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    };
    const counts: Record<string, number> = {};
    for (const i of publishedRecent) if (isToday(i.publishedAt)) counts[i.channelId] = (counts[i.channelId] ?? 0) + 1;
    return counts;
  }, [publishedRecent]);

  /** v964 — warum liegt ein fälliger Beitrag noch herum? (Tages-Limit war im Log unsichtbar) */
  function blockedHint(item: SocialContentItem): string | null {
    if (!item.scheduledAt || new Date(item.scheduledAt).getTime() > Date.now()) return null;
    if (item.status === 'scheduled') return 'Termin verstrichen — wartet noch auf deine Freigabe.';
    if (item.status !== 'approved') return null;
    const channel = channels.find(c => c.id === item.channelId);
    const today = publishedTodayByChannel[item.channelId] ?? 0;
    if (channel && today >= channel.maxPostsPerDay) {
      return `Tages-Limit erreicht (${today}/${channel.maxPostsPerDay}) — postet nach Mitternacht, oder Limit im Kanal erhöhen.`;
    }
    return 'Überfällig — die Engine postet beim nächsten Tick (≤ 5 min). Bleibt das so, Logs prüfen.';
  }

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function setMode(channel: SocialChannelItem, mode: string) {
    await withBusy(channel.id, async () => { await client!.updateSocialChannel(channel.id, { mode }); await load(); });
  }

  async function toggleChannelStatus(channel: SocialChannelItem) {
    const status = channel.status === 'active' ? 'paused' : 'active';
    await withBusy(channel.id, async () => { await client!.updateSocialChannel(channel.id, { status }); await load(); });
  }

  async function pauseAll() {
    if (!confirm('🛑 Social-Stopp: ALLE Kanäle sofort pausieren?')) return;
    await withBusy('pause-all', async () => {
      const n = await client!.socialPauseAll();
      alert(`${n} Kanal/Kanäle pausiert.`);
      await load();
    });
  }

  async function itemAction(item: SocialContentItem, action: 'approve' | 'reject' | 'publish' | 'delete' | 'remove') {
    if (action === 'delete' && !confirm('Beitrag auf der Plattform UND in Alfred löschen?')) return;
    // v987 — lokal löschen (ohne Story-Sperre): Studio darf den Stoff neu aufgreifen
    if (action === 'remove' && !confirm('Beitrag lokal löschen? (Ohne Story-Sperre — das Studio darf das Thema neu aufgreifen. Zum Sperren stattdessen „Ablehnen".)')) return;
    await withBusy(item.id, async () => {
      const r = await client!.socialItemAction(item.id, action);
      if (!r.success) throw new Error(r.error ?? 'Aktion fehlgeschlagen');
      if (r.display) setNotice(r.display);
      await load();
      if (page === 'history') await loadHistory();
    });
  }

  // v964 — Umterminieren: Datepicker → schedule mit Wunschtermin
  function startReschedule(item: SocialContentItem) {
    setReschedulingId(item.id);
    setRescheduleAt(toLocalInput(item.scheduledAt));
  }

  async function saveReschedule(item: SocialContentItem) {
    const at = new Date(rescheduleAt);
    if (Number.isNaN(at.getTime())) { setError('Ungültiger Zeitpunkt.'); return; }
    await withBusy(item.id, async () => {
      const r = await client!.socialItemAction(item.id, 'schedule', { scheduled_at: at.toISOString() });
      if (!r.success) throw new Error(r.error ?? 'Umterminieren fehlgeschlagen');
      setReschedulingId(null);
      await load();
    });
  }

  // ── v966 — Composer: Beitrag anlegen (Entwurf / terminiert / sofort) ──
  async function submitComposer(kind: 'draft' | 'schedule' | 'publish') {
    if (!composer.channel || composer.body.trim().length < 10) {
      setError('Kanal und Text (mindestens 10 Zeichen) erforderlich.');
      return;
    }
    if (kind === 'schedule' && !composer.scheduledAt) {
      setError('Bitte einen Zeitpunkt wählen.');
      return;
    }
    await withBusy('composer', async () => {
      const r = await client!.socialCreateItem({
        channel: composer.channel,
        title: composer.title.trim() || undefined,
        body: composer.body,
        hashtags: composer.hashtags.split(',').map(h => h.trim().replace(/^#/, '')).filter(Boolean),
        media_url: composer.mediaUrl.trim() || undefined,
        scheduled_at: kind === 'schedule' ? new Date(composer.scheduledAt).toISOString() : undefined,
        publish_now: kind === 'publish',
      });
      if (!r.success) throw new Error(r.error ?? 'Anlegen fehlgeschlagen');
      if (r.display) setNotice(r.display);
      setComposerOpen(false);
      setComposer(c => ({ channel: c.channel, title: '', body: '', hashtags: '', mediaUrl: '', scheduledAt: '' }));
      await load();
    });
  }

  // v1024 — Ad-hoc-Story: Stoff → echte Redaktions-Story auf allen Familien-Kanälen
  async function submitStory() {
    if (story.stoff.trim().length < 20) {
      setError('Bitte den Stoff in 1-6 Sätzen beschreiben (mit den Fakten) — mindestens 20 Zeichen.');
      return;
    }
    await withBusy('plan-story', async () => {
      const r = await client!.socialPlanStory({
        stoff: story.stoff.trim(),
        titel: story.titel.trim() || undefined,
      });
      if (!r.success) throw new Error(r.error ?? 'Story-Planung fehlgeschlagen');
      if (r.display) setNotice(r.display);
      setStoryOpen(false);
      setStory({ titel: '', stoff: '' });
      await load();
    });
  }

  // v966 — Crosspost: Item formatgerecht auf andere Kanäle übernehmen
  function startCrosspost(item: SocialContentItem) {
    setCrosspostId(item.id);
    setCrosspostSel({});
  }

  async function doCrosspost(item: SocialContentItem) {
    const targets = channels.filter(c => crosspostSel[c.id]).map(c => c.name);
    if (targets.length === 0) { setError('Mindestens einen Ziel-Kanal wählen.'); return; }
    await withBusy(item.id, async () => {
      const r = await client!.socialCrosspost(item.id, targets);
      if (!r.success) throw new Error(r.error ?? 'Crosspost fehlgeschlagen');
      if (r.display) setNotice(r.display);
      setCrosspostId(null);
      await load();
    });
  }

  // ── v965 — Kanal-Einstellungen ──
  function openSettings(c: SocialChannelItem) {
    setSettingsId(c.id);
    setLinkTopicSel('');
    setSettingsDraft({
      persona: c.persona ?? '',
      slots: c.postingSlots.join(', '),
      blacklist: c.blacklist.join(', '),
      maxPostsPerDay: c.maxPostsPerDay,
      planningHorizonDays: c.planningHorizonDays,
      generateImages: c.config.generate_images === true,
      imageBudgetTotal: typeof c.config.image_budget_per_month === 'number' ? c.config.image_budget_per_month : 30,
      lessons: Array.isArray(c.config.lessons) ? c.config.lessons.map(String) : [],
      newLesson: '',
      modelTier: typeof c.config.model_tier === 'string' ? c.config.model_tier : 'fast',
      // v996 — Familien-Playbook aus der Kanal-Config
      familyRole: c.config.family_role === 'lead' ? 'lead' : c.config.family_role === 'follow' ? 'follow' : 'auto',
      familyOffset: typeof c.config.family_offset_hours === 'number' ? String(c.config.family_offset_hours) : '',
      quietFrom: Array.isArray(c.config.newsdesk_quiet) ? Number((c.config.newsdesk_quiet as unknown[])[0] ?? 22) : 22,
      quietTo: Array.isArray(c.config.newsdesk_quiet) ? Number((c.config.newsdesk_quiet as unknown[])[1] ?? 6) : 6,
      newsdeskThreshold: typeof c.config.newsdesk_threshold === 'number' ? c.config.newsdesk_threshold : 0.85,
      newsdeskMaxPerDay: typeof c.config.newsdesk_max_per_day === 'number' ? c.config.newsdesk_max_per_day : 3,
      trafficMode: c.config.traffic_mode === 'teaser' ? 'teaser' : c.config.traffic_mode === 'auto' ? 'auto' : 'voll',
      // v1004 — Bild-Look
      imageStyle: typeof c.config.image_style === 'string' ? c.config.image_style : '',
      imageQuality: c.config.image_quality === 'low' || c.config.image_quality === 'medium' || c.config.image_quality === 'high' ? c.config.image_quality : 'default',
      imageBranding: typeof c.config.image_branding === 'string' ? c.config.image_branding : '',
      watermarkOn: (c.config.image_overlay as { watermark?: boolean } | undefined)?.watermark !== false && c.config.image_branding !== false,
      titleOverlayOn: (c.config.image_overlay as { title?: boolean } | undefined)?.title === true,
      // v1026 — Ecken + Logo
      watermarkCorner: typeof (c.config.image_overlay as { watermark_corner?: string } | undefined)?.watermark_corner === 'string'
        ? String((c.config.image_overlay as { watermark_corner?: string }).watermark_corner) : 'bottom-right',
      logoSvg: typeof (c.config.image_overlay as { logo?: { svg?: string } } | undefined)?.logo?.svg === 'string'
        ? String((c.config.image_overlay as { logo?: { svg?: string } }).logo!.svg) : '',
      logoCorner: typeof (c.config.image_overlay as { logo?: { corner?: string } } | undefined)?.logo?.corner === 'string'
        ? String((c.config.image_overlay as { logo?: { corner?: string } }).logo!.corner) : 'bottom-right',
      logoColor: typeof (c.config.image_overlay as { logo?: { color?: string } } | undefined)?.logo?.color === 'string'
        ? String((c.config.image_overlay as { logo?: { color?: string } }).logo!.color) : '',
      // v1041 — Termin-Vorlage (Asset-ID)
      terminImage: typeof (c.config.image_overlay as { termin_image?: string } | undefined)?.termin_image === 'string'
        ? String((c.config.image_overlay as { termin_image?: string }).termin_image) : '',
      // v1006 — Sprache + Übersetzungen
      language: typeof c.config.language === 'string' && c.config.language ? c.config.language : 'de',
      translateTo: Array.isArray(c.config.translate_to) ? (c.config.translate_to as unknown[]).filter((l): l is string => typeof l === 'string') : [],
      autoStory: c.config.auto_story === true,
      imageCarousel: c.config.image_carousel === true,
      autoReel: c.config.auto_reel === true,
      // v1060 — Reels & Video
      reelMaxPerWeek: typeof c.config.reel_max_per_week === 'number' ? c.config.reel_max_per_week : 2,
      reelCtaText: typeof c.config.reel_cta_text === 'string' ? c.config.reel_cta_text : '',
      reelMusicOn: c.config.reel_music !== false,
      reelMusicVolume: typeof c.config.reel_music_volume === 'number' ? String(c.config.reel_music_volume) : '',
      reelAiClips: c.config.reel_ai_clips === 1 || c.config.reel_ai_clips === 2 ? c.config.reel_ai_clips : 0,
      reelAiProvider: c.config.reel_ai_provider === 'runway' || c.config.reel_ai_provider === 'veo' ? c.config.reel_ai_provider : 'sora',
      reelAiModel: typeof c.config.reel_ai_model === 'string' ? c.config.reel_ai_model : '',
      aiClipBudget: typeof c.config.ai_clip_budget_per_month === 'number' ? c.config.ai_clip_budget_per_month : 8,
      // v1066 — Dauer-Branding · v1067 — Anordnung + Logo-Ecke
      reelWatermark: c.config.reel_watermark === 'text' || c.config.reel_watermark === 'logo' || c.config.reel_watermark === 'both' ? c.config.reel_watermark : 'aus',
      reelWatermarkCorner: typeof c.config.reel_watermark_corner === 'string' ? c.config.reel_watermark_corner : 'bottom-right',
      reelWatermarkLayout: c.config.reel_watermark_layout === 'stack_fit' || c.config.reel_watermark_layout === 'split' ? c.config.reel_watermark_layout : 'stack',
      reelWatermarkLogoCorner: typeof c.config.reel_watermark_logo_corner === 'string' ? c.config.reel_watermark_logo_corner : 'top-left',
      formate: Array.isArray(c.config.formate)
        ? (c.config.formate as Array<{ slot?: unknown; name?: unknown; anweisung?: unknown }>)
          .filter(f => f && typeof f.slot === 'string' && typeof f.name === 'string')
          .map(f => ({ slot: String(f.slot), name: String(f.name), anweisung: typeof f.anweisung === 'string' ? f.anweisung : '' }))
        : [],
    });
    if (interestTopics.length === 0) {
      client?.fetchInterestTopics().then(setInterestTopics).catch(() => {});
    }
    // v1041 — Bibliothek für den Termin-Vorlagen-Selektor nachladen
    if (assets.length === 0) loadAssets().catch(() => {});
  }

  async function saveSettings(c: SocialChannelItem) {
    const d = settingsDraft;
    const csv = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
    const lessons = d.newLesson.trim() ? [...d.lessons, d.newLesson.trim()] : d.lessons;
    await withBusy(c.id, async () => {
      await client!.updateSocialChannel(c.id, {
        persona: d.persona,
        postingSlots: csv(d.slots),
        blacklist: csv(d.blacklist),
        maxPostsPerDay: d.maxPostsPerDay,
        planningHorizonDays: d.planningHorizonDays,
        config: {
          generate_images: d.generateImages, image_budget_per_month: d.imageBudgetTotal, lessons, model_tier: d.modelTier,
          // v996 — Familien-Playbook (null löscht den Schlüssel, config wird feldweise gemergt)
          family_role: d.familyRole === 'auto' ? null : d.familyRole,
          family_offset_hours: d.familyOffset.trim() === '' ? null : Number(d.familyOffset),
          traffic_mode: d.trafficMode === 'voll' ? null : d.trafficMode,
          newsdesk_quiet: [d.quietFrom, d.quietTo],
          newsdesk_threshold: d.newsdeskThreshold,
          newsdesk_max_per_day: d.newsdeskMaxPerDay,
          // v1004 — Bild-Look (config wird feldweise gemergt)
          image_style: d.imageStyle.trim() || null,
          image_quality: d.imageQuality === 'default' ? null : d.imageQuality,
          image_branding: d.imageBranding.trim() || null,
          image_overlay: {
            watermark: d.watermarkOn, title: d.titleOverlayOn,
            // v1026 — Ecken + Logo (config wird feldweise gemergt, null löscht)
            watermark_corner: d.watermarkCorner === 'bottom-right' ? null : d.watermarkCorner,
            logo: d.logoSvg.trim().startsWith('<svg')
              ? { svg: d.logoSvg, corner: d.logoCorner, color: /^#[0-9a-fA-F]{3,8}$/.test(d.logoColor.trim()) ? d.logoColor.trim() : null }
              : null,
            // v1041 — Termin-Vorlage (Asset-ID; null löscht = wieder generieren)
            termin_image: d.terminImage.trim() || null,
          },
          // v1006 — Sprache (Default de → Schlüssel löschen) + Übersetzungs-Ziele
          language: d.language === 'de' ? null : d.language,
          translate_to: d.translateTo.length > 0 ? d.translateTo : null,
          // v1007 — Auto-Story (nur Instagram wirksam) · v1008 — Karussells · v1016 — Auto-Reels
          auto_story: d.autoStory ? true : null,
          image_carousel: d.imageCarousel ? true : null,
          auto_reel: d.autoReel ? true : null,
          // v1060 — Reels & Video (Defaults → Schlüssel löschen)
          reel_max_per_week: d.reelMaxPerWeek === 2 ? null : d.reelMaxPerWeek,
          reel_cta_text: d.reelCtaText.trim() || null,
          reel_music: d.reelMusicOn ? null : false,
          reel_music_volume: d.reelMusicVolume.trim() !== '' && Number(d.reelMusicVolume) > 0 && Number(d.reelMusicVolume) <= 1 ? Number(d.reelMusicVolume) : null,
          reel_ai_clips: d.reelAiClips > 0 ? d.reelAiClips : null,
          reel_ai_provider: d.reelAiClips > 0 && d.reelAiProvider !== 'sora' ? d.reelAiProvider : null,
          reel_ai_model: d.reelAiClips > 0 && d.reelAiModel.trim() ? d.reelAiModel.trim() : null,
          ai_clip_budget_per_month: d.reelAiClips > 0 && d.aiClipBudget !== 8 ? d.aiClipBudget : null,
          // v1066 — Dauer-Branding (aus = Schlüssel löschen = Standard wie bisher)
          reel_watermark: d.reelWatermark === 'aus' ? null : d.reelWatermark,
          reel_watermark_corner: d.reelWatermark !== 'aus' && d.reelWatermarkCorner !== 'bottom-right' ? d.reelWatermarkCorner : null,
          // v1067 — Anordnung bei Text+Logo + eigene Logo-Ecke bei „getrennt"
          reel_watermark_layout: d.reelWatermark === 'both' && d.reelWatermarkLayout !== 'stack' ? d.reelWatermarkLayout : null,
          reel_watermark_logo_corner: d.reelWatermark === 'both' && d.reelWatermarkLayout === 'split' && d.reelWatermarkLogoCorner !== 'top-left' ? d.reelWatermarkLogoCorner : null,
          // v1012 — Serien-Formate
          formate: d.formate.filter(f => f.slot.trim() && f.name.trim()).length > 0
            ? d.formate.filter(f => f.slot.trim() && f.name.trim()).map(f => ({ slot: f.slot.trim(), name: f.name.trim(), anweisung: f.anweisung.trim() }))
            : null,
        },
      });
      setSettingsId(null);
      await load();
    });
  }

  // v965 — Kanal-Aktionen (Studio-Lauf, Umplanung, Auth-Check, Themen verknüpfen)
  async function channelAction(c: SocialChannelItem, action: 'generate' | 'replan' | 'validate-auth' | 'link-topic' | 'unlink-topic', extra?: { topic?: string }) {
    await withBusy(`${c.id}:${action}`, async () => {
      const r = await client!.socialChannelAction(c.id, action, extra);
      if (!r.success) throw new Error(r.error ?? 'Aktion fehlgeschlagen');
      if (r.display) setNotice(r.display);
      await load();
    });
  }

  // v955 — Korrektur speichern (optional mit Lektion → Kanal lernt daraus)
  function startEdit(item: SocialContentItem) {
    setEditingId(item.id);
    setEditDraft({
      title: item.title ?? '',
      body: item.body,
      hashtags: item.hashtags.join(', '),
      lesson: '',
    });
  }

  async function saveEdit(item: SocialContentItem) {
    await withBusy(item.id, async () => {
      const r = await client!.socialItemAction(item.id, 'edit', {
        title: editDraft.title,
        body: editDraft.body,
        hashtags: editDraft.hashtags.split(',').map(h => h.trim().replace(/^#/, '')).filter(Boolean),
        ...(editDraft.lesson.trim() ? { lesson: editDraft.lesson.trim() } : {}),
      });
      if (!r.success) throw new Error(r.error ?? 'Speichern fehlgeschlagen');
      setEditingId(null);
      await load();
    });
  }

  // v964 — Kanal-Filter auf Queue, Verlauf und Kalender
  const filterByChannel = useCallback(
    (items: SocialContentItem[]) => (channelFilter ? items.filter(i => i.channelId === channelFilter) : items),
    [channelFilter],
  );
  const visibleHistory = useMemo(() => filterByChannel(history), [history, filterByChannel]);

  /** Kalender nach Tag gruppiert (kommende 14 Tage) — v964: lokale Tage. */
  const calendarByDay = useMemo(() => {
    const map = new Map<string, SocialContentItem[]>();
    for (const item of filterByChannel(calendar)) {
      const iso = item.scheduledAt ?? item.publishedAt;
      if (!iso) continue;
      const d = new Date(iso);
      const p = (n: number) => String(n).padStart(2, '0');
      const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      map.set(day, [...(map.get(day) ?? []), item]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [calendar, filterByChannel]);

  // v996 — Familien-Kalender: Kanäle einer Familie als Spalten, Stories farbcodiert
  const familyCalendars = useMemo(() => {
    const groups = new Map<string, SocialChannelItem[]>();
    for (const c of channels.filter(ch => ch.status !== 'archived')) {
      const key = familyKeyOf(c);
      if (key) groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    const storyColor = new Map<string, string>();
    for (const i of calendar) {
      if (i.storyId && !storyColor.has(i.storyId)) storyColor.set(i.storyId, STORY_PALETTE[storyColor.size % STORY_PALETTE.length]);
    }
    const storyTitle = new Map<string, string>();
    for (const i of calendar) {
      if (i.storyId && i.storyTitle && !storyTitle.has(i.storyId)) storyTitle.set(i.storyId, i.storyTitle);
    }
    return { families: [...groups.entries()].filter(([, m]) => m.length >= 2), storyColor, storyTitle };
  }, [channels, calendar]);

  /** v996 — lokaler Tages-Schlüssel eines Items (scheduledAt/publishedAt). */
  function itemDayKey(i: SocialContentItem): string | null {
    const iso = i.scheduledAt ?? i.publishedAt;
    if (!iso) return null;
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // v1000 — Triage: Was braucht DEINE Entscheidung (Entwürfe + geplante vor Freigabe),
  // was läuft von selbst (approved), was ist ein Problem (failed)?
  const decisions = useMemo(() => {
    const actionable = filterByChannel(pending).filter(i => i.status === 'draft' || i.status === 'scheduled');
    const cutoff = Date.now() + 24 * 3_600_000;
    const urgent = actionable.filter(i => i.scheduledAt && Date.parse(i.scheduledAt) < cutoff);
    const urgentIds = new Set(urgent.map(i => i.id));
    return {
      urgent,
      later: actionable.filter(i => !urgentIds.has(i.id)),
      approved: filterByChannel(pending).filter(i => i.status === 'approved'),
      failed: filterByChannel(failedItems),
    };
  }, [pending, failedItems, filterByChannel]);

  const selCount = useMemo(() => Object.values(sel).filter(Boolean).length, [sel]);

  // v1000 — Bulk-Freigabe/-Ablehnung: läuft item-weise durch den Skill (alle Leitplanken bleiben)
  async function bulkAction(action: 'approve' | 'reject') {
    const ids = Object.entries(sel).filter(([, v]) => v).map(([k]) => k);
    if (ids.length === 0) return;
    if (action === 'reject' && !confirm(`${ids.length} Beiträge ablehnen? (Der Stoff wird für das Studio gesperrt.)`)) return;
    setBusy('bulk'); setError(null);
    let ok = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        const r = await client!.socialItemAction(id, action);
        if (r.success) ok++; else errors.push(`${id.slice(0, 8)}: ${r.error ?? '?'}`);
      } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
    }
    setSel({});
    setBusy(null);
    setNotice(`${ok}/${ids.length} ${action === 'approve' ? 'freigegeben' : 'abgelehnt'}.${errors.length ? `\nFehler: ${errors.slice(0, 3).join(' · ')}` : ''}`);
    await load();
  }

  function selectGroup(items: SocialContentItem[], on: boolean) {
    setSel(s => {
      const next = { ...s };
      for (const i of items) if (i.status === 'draft' || i.status === 'scheduled') next[i.id] = on;
      return next;
    });
  }

  // v1000 — Status-Kopfzeile: nächster anstehender Termin je Kanal
  const nextSlotByChannel = useMemo(() => {
    const next: Record<string, string> = {};
    const now = Date.now();
    for (const i of [...pending, ...calendar]) {
      if (!i.scheduledAt || i.status === 'published' || Date.parse(i.scheduledAt) < now) continue;
      if (!next[i.channelId] || i.scheduledAt < next[i.channelId]) next[i.channelId] = i.scheduledAt;
    }
    return next;
  }, [pending, calendar]);

  // v1001 — Detail-Sheet: Item + Story-Geschwister über alle geladenen Listen
  const allItems = useMemo(() => {
    const map = new Map<string, SocialContentItem>();
    for (const i of [...publishedRecent, ...history, ...failedItems, ...calendar, ...pending]) map.set(i.id, i);
    return map;
  }, [pending, calendar, history, publishedRecent, failedItems]);
  const detailItem = detailId ? allItems.get(detailId) ?? null : null;
  const detailSiblings = useMemo(() => {
    if (!detailItem?.storyId) return [];
    return [...allItems.values()]
      .filter(i => i.storyId === detailItem.storyId && i.id !== detailItem.id)
      .sort((a, b) => (a.scheduledAt ?? a.publishedAt ?? '9999').localeCompare(b.scheduledAt ?? b.publishedAt ?? '9999'));
  }, [allItems, detailItem]);
  const detailStoryTitle = useMemo(() => {
    if (!detailItem?.storyId) return undefined;
    return detailItem.storyTitle
      ?? [...allItems.values()].find(i => i.storyId === detailItem.storyId && i.storyTitle)?.storyTitle;
  }, [allItems, detailItem]);

  // v1020 — Kanalwachstum: followers-Zeitreihe je Kanal (Level-Werte, 1/Tag) + Deltas
  const growth = useMemo(() => {
    const byChannel: Record<string, { series: Array<{ date: string; value: number }>; latest: number; delta7: number; delta30: number }> = {};
    for (const c of channels) {
      const byDate = new Map<string, number>();
      for (const m of metrics[c.id] ?? []) {
        if (m.kind !== 'followers' || m.itemId) continue;
        byDate.set(m.date, m.value);
      }
      const series = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
      if (series.length === 0) continue;
      const latest = series[series.length - 1].value;
      const at = (days: number) => {
        const cut = new Date(Date.now() - days * 24 * 3_600_000).toISOString().slice(0, 10);
        const older = series.filter(s => s.date <= cut);
        return older.length > 0 ? older[older.length - 1].value : series[0].value;
      };
      byChannel[c.id] = { series, latest, delta7: latest - at(7), delta30: latest - at(30) };
    }
    return byChannel;
  }, [channels, metrics]);

  /** v1020 — Familien-Wachstum: Summe je Datum über alle Familien-Kanäle mit Daten. */
  const familyGrowth = useMemo(() => {
    const out: Array<{ famKey: string; members: SocialChannelItem[]; total: number; delta7: number; driver?: { name: string; delta7: number; pct: number } }> = [];
    for (const [famKey, members] of familyCalendars.families) {
      const withData = members.filter(m => growth[m.id]);
      if (withData.length === 0) continue;
      const total = withData.reduce((s, m) => s + growth[m.id].latest, 0);
      const delta7 = withData.reduce((s, m) => s + growth[m.id].delta7, 0);
      let driver: { name: string; delta7: number; pct: number } | undefined;
      for (const m of withData) {
        const g = growth[m.id];
        const base = Math.max(1, g.latest - g.delta7);
        const pct = (g.delta7 / base) * 100;
        if (g.delta7 > 0 && (!driver || pct > driver.pct)) driver = { name: m.name, delta7: g.delta7, pct };
      }
      out.push({ famKey, members: withData, total, delta7, driver });
    }
    return out;
  }, [familyCalendars, growth]);

  // v967 — Analytics: Zeitreihen je Metrik-Art + Top-Beiträge je Kanal
  const analytics = useMemo(() => {
    const titleById = new Map<string, string>();
    for (const i of [...publishedRecent, ...pending, ...calendar, ...history]) {
      titleById.set(i.id, i.title ?? i.body.slice(0, 60));
    }
    return channels.map(c => {
      const entries = metrics[c.id] ?? [];
      // Zeitreihen: je kind die Tageswerte aufsummiert (gen_image ist Budget, kein Engagement)
      const byKind = new Map<string, Map<string, number>>();
      const byItem = new Map<string, number>();
      for (const e of entries) {
        // gen_image ist Budget, followers ein Level-Wert — beide haben eigene Ansichten
        if (e.kind === 'gen_image' || e.kind === 'followers') continue;
        const days = byKind.get(e.kind) ?? new Map<string, number>();
        days.set(e.date, (days.get(e.date) ?? 0) + e.value);
        byKind.set(e.kind, days);
        if (e.itemId) byItem.set(e.itemId, (byItem.get(e.itemId) ?? 0) + e.value);
      }
      const series = [...byKind.entries()]
        .map(([kind, days]) => {
          const sorted = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
          return { kind, total: sorted.reduce((s, [, v]) => s + v, 0), points: sorted.map(([, v]) => v) };
        })
        .sort((a, b) => b.total - a.total)
        .slice(0, 3);
      const topPosts = [...byItem.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, total]) => ({ id, total, title: titleById.get(id) ?? id.slice(0, 8) }));
      return { channel: c, series, topPosts };
    }).filter(a => a.series.length > 0 || a.topPosts.length > 0);
  }, [channels, metrics, publishedRecent, pending, calendar, history]);

  function channelMetricSummary(channelId: string): string {
    const m = metrics[channelId] ?? [];
    if (m.length === 0) return '';
    const latestByKind = new Map<string, number>();
    for (const entry of m) {
      if (!entry.itemId) continue;
      latestByKind.set(entry.kind, (latestByKind.get(entry.kind) ?? 0) + entry.value);
    }
    return [...latestByKind.entries()].slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ');
  }

  function renderItemCard(item: SocialContentItem, showActions: boolean, selectable = false) {
    const isOpen = expandedItem === item.id;
    const previewUrl = mediaUrls[item.id];
    const hasVideo = item.media?.some(m => m.type === 'video');
    const hint = blockedHint(item);
    return (
      <div key={item.id} className={clsx('border rounded-lg p-3', sel[item.id] ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-[#1f1f1f]')}>
        <div className="flex items-center gap-2 flex-wrap text-xs">
          {/* v1000 — Bulk-Auswahl (nur für Items, die eine Freigabe-Entscheidung brauchen) */}
          {selectable && (item.status === 'draft' || item.status === 'scheduled') && (
            <input type="checkbox" checked={sel[item.id] === true}
              onChange={e => setSel(s => ({ ...s, [item.id]: e.target.checked }))}
              className="accent-emerald-500 cursor-pointer" />
          )}
          <span className={clsx('px-1.5 py-0.5 rounded uppercase text-[10px]', STATUS_BADGE[item.status] ?? '')}>{item.status}</span>
          <span className="text-gray-400">{channelName(item.channelId)}</span>
          {item.scheduledAt && item.status !== 'published' && (
            <span className="text-gray-500" title={item.scheduledAt}>⏰ {fmtDateTime(item.scheduledAt)} <span className="text-gray-600">({fmtRelative(item.scheduledAt)})</span></span>
          )}
          {item.publishedAt && <span className="text-gray-500" title={item.publishedAt}>✅ {fmtDateTime(item.publishedAt)}</span>}
          {item.source === 'studio' && <span className="text-purple-400 text-[10px]">Studio</span>}
          {item.error && <span className="text-red-400 truncate max-w-[200px]" title={item.error}>⚠ {item.error.slice(0, 40)}</span>}
          <div className="flex-1" />
          <span className="font-mono text-gray-600">{item.id.slice(0, 8)}</span>
        </div>
        {/* v964 — sichtbarer Blockade-Grund (Tages-Limit stand vorher nur im Server-Log) */}
        {hint && (
          <div className="mt-2 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">⏳ {hint}</div>
        )}
        {/* v955 — Inline-Editor: Korrektur + optionale Lektion */}
        {editingId === item.id ? (
          <div className="mt-2 space-y-2">
            <input value={editDraft.title} onChange={e => setEditDraft(d => ({ ...d, title: e.target.value }))}
              placeholder="Titel"
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200" />
            <textarea value={editDraft.body} onChange={e => setEditDraft(d => ({ ...d, body: e.target.value }))}
              rows={6}
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200" />
            <input value={editDraft.hashtags} onChange={e => setEditDraft(d => ({ ...d, hashtags: e.target.value }))}
              placeholder="Hashtags (kommagetrennt)"
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200" />
            <input value={editDraft.lesson} onChange={e => setEditDraft(d => ({ ...d, lesson: e.target.value }))}
              placeholder='📚 Lektion für künftige Entwürfe (optional), z.B. "Es ist die WM 2026, nicht die EM"'
              className="w-full bg-[#0a0a0a] border border-purple-500/30 rounded px-2 py-1.5 text-xs text-purple-200" />
            <div className="flex gap-2">
              <button onClick={() => saveEdit(item)} disabled={busy === item.id}
                className="px-2 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded">✓ Speichern</button>
              <button onClick={() => setEditingId(null)}
                className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded">Abbrechen</button>
            </div>
          </div>
        ) : (
          <div className="mt-1.5 text-sm text-gray-200 font-medium">{item.title ?? item.body.slice(0, 80)}</div>
        )}
        {/* v948 — Medien-Vorschau: generierte/angehängte Bilder + Video-Badge */}
        {(previewUrl || hasVideo) && (
          <div className="flex items-center gap-2 mt-2">
            {previewUrl && (
              <img src={previewUrl} alt="" className="h-24 rounded border border-[#2a2a2a] object-cover" />
            )}
            {hasVideo && <span className="text-[10px] px-1.5 py-0.5 bg-purple-500/20 text-purple-300 rounded">🎬 Video angehängt</span>}
          </div>
        )}
        {editingId !== item.id && (
          <>
            <div className={clsx('text-xs text-gray-400 whitespace-pre-wrap break-words mt-1', !isOpen && 'line-clamp-2')}>
              {item.body}
              {item.hashtags.length > 0 && <div className="text-blue-400 mt-1">{item.hashtags.map(h => `#${h.replace(/^#/, '')}`).join(' ')}</div>}
            </div>
            {item.body.length > 150 && (
              <button onClick={() => setExpandedItem(isOpen ? null : item.id)} className="text-[11px] text-blue-400 hover:text-blue-300 mt-1">
                {isOpen ? '▲ einklappen' : '▼ ganzen Text zeigen'}
              </button>
            )}
          </>
        )}
        {/* v964 — Umterminieren */}
        {reschedulingId === item.id && (
          <div className="flex items-center gap-2 mt-2">
            <input type="datetime-local" value={rescheduleAt} onChange={e => setRescheduleAt(e.target.value)}
              className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200" />
            <button onClick={() => saveReschedule(item)} disabled={busy === item.id}
              className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded">✓ Termin setzen</button>
            <button onClick={() => setReschedulingId(null)}
              className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded">Abbrechen</button>
          </div>
        )}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {/* v1001 — Detail-Sheet: großes Bild, voller Text, Story-Geschwister */}
          <button onClick={() => setDetailId(item.id)}
            className="px-2 py-1 text-xs border border-[#2a2a2a] text-gray-400 hover:bg-[#1a1a1a] rounded">🔍 Details</button>
          {item.externalUrl && (
            <a href={item.externalUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:text-blue-300">🔗 Post öffnen</a>
          )}
          {showActions && editingId !== item.id && reschedulingId !== item.id && (item.status === 'draft' || item.status === 'scheduled' || item.status === 'failed' || item.status === 'approved') && (
            <>
              {item.status !== 'failed' && item.status !== 'approved' && (
                <button onClick={() => itemAction(item, 'approve')} disabled={busy === item.id}
                  className="px-2 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded">✅ Freigeben</button>
              )}
              <button onClick={() => itemAction(item, 'publish')} disabled={busy === item.id}
                className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded">🚀 Sofort posten</button>
              <button onClick={() => startReschedule(item)} disabled={busy === item.id}
                className="px-2 py-1 text-xs border border-blue-500/40 text-blue-400 hover:bg-blue-500/15 rounded">📅 Umterminieren</button>
              <button onClick={() => startEdit(item)} disabled={busy === item.id}
                className="px-2 py-1 text-xs border border-amber-500/40 text-amber-400 hover:bg-amber-500/15 rounded">✏️ Bearbeiten</button>
              <button onClick={() => { setImprovingId(improvingId === item.id ? null : item.id); setImproveText(''); }} disabled={busy === item.id}
                className="px-2 py-1 text-xs border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/15 rounded">✨ Verbessern</button>
              <button onClick={() => itemAction(item, 'reject')} disabled={busy === item.id}
                className="px-2 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/15 rounded">✕ Ablehnen</button>
            </>
          )}
          {/* v966 — Crosspost auf andere Kanäle (formatgerecht umgeschrieben) */}
          {channels.length > 1 && item.status !== 'rejected' && (
            <button onClick={() => (crosspostId === item.id ? setCrosspostId(null) : startCrosspost(item))} disabled={busy === item.id}
              className="px-2 py-1 text-xs border border-purple-500/40 text-purple-300 hover:bg-purple-500/15 rounded">🔁 Crosspost</button>
          )}
          {/* v964 — published: auf der Plattform löschen (delete_remote-Leitplanke) */}
          {item.status === 'published' && (
            <button onClick={() => itemAction(item, 'delete')} disabled={busy === item.id}
              className="px-2 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/15 rounded">🗑 Löschen</button>
          )}
          {/* v987 — ungepublisht: lokal löschen OHNE Story-Sperre (Studio darf neu aufgreifen) */}
          {item.status !== 'published' && (
            <button onClick={() => itemAction(item, 'remove')} disabled={busy === item.id}
              className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded">🗑 Löschen (ohne Sperre)</button>
          )}
        </div>
        {/* v991 — Verbessern: Anweisung → Text-Überarbeitung ODER Bild neu */}
        {improvingId === item.id && (
          <div className="mt-2 space-y-1">
            <textarea value={improveText} onChange={e => setImproveText(e.target.value)} rows={2}
              placeholder='Anweisung, z.B. "halb so lang, mehr Community-Frage" — fürs Bild z.B. "beide Flaggen, ohne Menschen"'
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200" />
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => withBusy(item.id, async () => {
                const r = await client!.socialItemAction(item.id, 'revise', { instruction: improveText });
                if (!r.success) throw new Error(r.error ?? 'Überarbeitung fehlgeschlagen');
                if (r.display) setNotice(r.display);
                setImprovingId(null); await load();
              })} disabled={busy === item.id || improveText.trim().length === 0}
                className="px-2 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded">✨ Text überarbeiten</button>
              <button onClick={() => withBusy(item.id, async () => {
                const r = await client!.socialItemAction(item.id, 'regenerate-image', improveText.trim() ? { hint: improveText } : undefined);
                if (!r.success) throw new Error(r.error ?? 'Bild-Neuerzeugung fehlgeschlagen');
                if (r.display) setNotice(r.display);
                setImprovingId(null); await load();
              })} disabled={busy === item.id}
                className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded">🎨 Bild neu generieren</button>
              <span className="text-gray-600 text-[10px]">Status und Termin bleiben erhalten; Bild läuft durch alle Prüfungen und zählt aufs Budget.</span>
            </div>
          </div>
        )}
        {crosspostId === item.id && (
          <div className="flex items-center gap-2 mt-2 flex-wrap text-xs">
            <span className="text-gray-500">Ziel-Kanäle:</span>
            {channels.filter(c => c.id !== item.channelId).map(c => (
              <label key={c.id} className="flex items-center gap-1 text-gray-300 cursor-pointer">
                <input type="checkbox" checked={crosspostSel[c.id] === true}
                  onChange={e => setCrosspostSel(s => ({ ...s, [c.id]: e.target.checked }))} />
                {PLATFORM_ICON[c.platform] ?? '📣'} {c.name}
              </label>
            ))}
            <button onClick={() => doCrosspost(item)} disabled={busy === item.id}
              className="px-2 py-1 text-xs bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded">Übernehmen</button>
            <span className="text-gray-600 text-[10px]">Text wird je Ziel-Kanal angepasst; Kopien durchlaufen die normale Freigabe.</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">📣 Social Media</h1>
          <p className="text-sm text-gray-500">Kanäle, Content-Kalender und Freigaben — Alfred plant, du entscheidest (oder er, wenn du ihn lässt).</p>
        </div>
        <div className="flex items-center gap-2">
          {channels.length > 0 && (
            <button onClick={() => { setComposerOpen(o => !o); if (!composer.channel && channels[0]) setComposer(c => ({ ...c, channel: channels[0].name })); }}
              className={clsx('px-3 py-1.5 text-sm rounded border', composerOpen ? 'border-emerald-500/50 text-emerald-300 bg-emerald-500/10' : 'border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15')}>
              ➕ Neuer Beitrag
            </button>
          )}
          {channels.length > 1 && (
            <button onClick={() => setStoryOpen(o => !o)}
              className={clsx('px-3 py-1.5 text-sm rounded border', storyOpen ? 'border-amber-500/50 text-amber-300 bg-amber-500/10' : 'border-amber-500/40 text-amber-400 hover:bg-amber-500/15')}
              title="Ad-hoc-Story: dein Stoff wird als Redaktions-Story auf allen Familien-Kanälen ausgespielt">
              ⚡ Story anstoßen
            </button>
          )}
          <button onClick={pauseAll} disabled={busy === 'pause-all'}
            className="px-3 py-1.5 text-sm border border-red-500/40 text-red-400 hover:bg-red-500/15 disabled:opacity-50 rounded"
            title="Not-Aus: pausiert sofort alle Kanäle">🛑 Social-Stopp</button>
        </div>
      </div>

      {/* v1024 — Ad-hoc-Story: Stoff → je Kanal eigener Text (Persona/Sprache) + Bild, Lead +30 min, Follower +90 min */}
      {storyOpen && (
        <div className="border border-amber-500/30 rounded-lg p-4 space-y-2">
          <div className="text-xs text-gray-400">
            Dein Stoff wird als echte Redaktions-Story auf <b>allen Familien-Kanälen</b> ausgespielt — je Kanal eigener Text (Persona, Sprache) + Bild,
            Lead-Kanal in ~30 min, Follower in ~90 min. Freigaben kommen je nach Kanal-Modus. Fakten gehören in den Stoff — es wird nichts dazuerfunden.
          </div>
          <input value={story.titel} onChange={e => setStory(s => ({ ...s, titel: e.target.value }))} placeholder="Arbeitstitel (optional)"
            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200" />
          <textarea value={story.stoff} onChange={e => setStory(s => ({ ...s, stoff: e.target.value }))} rows={4}
            placeholder="Stoff in 1-6 Sätzen mit allen Fakten (Wer/Was/Wann/Kontext) …"
            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200" />
          <div className="flex items-center gap-2">
            <button onClick={submitStory} disabled={busy === 'plan-story'}
              className="px-2.5 py-1 text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded">⚡ Auf allen Kanälen ausspielen</button>
            {busy === 'plan-story' && <span className="text-xs text-gray-500">⏳ Redaktion schreibt je Kanal … (mit Bildern bis zu 2 Minuten)</span>}
          </div>
        </div>
      )}

      {/* v966 — Composer: eigener Beitrag (Bild kommt automatisch, wenn der Kanal generate_images hat) */}
      {composerOpen && (
        <div className="border border-emerald-500/30 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-gray-500">Kanal:</label>
            <select value={composer.channel} onChange={e => setComposer(c => ({ ...c, channel: e.target.value }))}
              className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
              {channels.map(c => <option key={c.id} value={c.name}>{PLATFORM_ICON[c.platform] ?? ''} {c.name}</option>)}
            </select>
            {(() => { const ch = channels.find(c => c.name === composer.channel); return ch?.config.generate_images === true
              ? <span className="text-[10px] text-purple-300">🎨 Bild wird automatisch generiert (falls kein eigenes angegeben)</span> : null; })()}
          </div>
          <input value={composer.title} onChange={e => setComposer(c => ({ ...c, title: e.target.value }))} placeholder="Titel (optional)"
            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200" />
          <textarea value={composer.body} onChange={e => setComposer(c => ({ ...c, body: e.target.value }))} rows={5} placeholder="Post-Text …"
            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200" />
          <div className="grid md:grid-cols-2 gap-2">
            <input value={composer.hashtags} onChange={e => setComposer(c => ({ ...c, hashtags: e.target.value }))} placeholder="Hashtags (kommagetrennt)"
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200" />
            <input value={composer.mediaUrl} onChange={e => setComposer(c => ({ ...c, mediaUrl: e.target.value }))} placeholder="Bild-/Video-URL (optional)"
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200" />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => submitComposer('draft')} disabled={busy === 'composer'}
              className="px-2.5 py-1 text-xs border border-gray-500/40 text-gray-300 hover:bg-gray-500/15 disabled:opacity-50 rounded">📝 Als Entwurf</button>
            <input type="datetime-local" value={composer.scheduledAt} onChange={e => setComposer(c => ({ ...c, scheduledAt: e.target.value }))}
              className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200" />
            <button onClick={() => submitComposer('schedule')} disabled={busy === 'composer'}
              className="px-2.5 py-1 text-xs border border-blue-500/40 text-blue-300 hover:bg-blue-500/15 disabled:opacity-50 rounded">📅 Terminieren</button>
            <button onClick={() => submitComposer('publish')} disabled={busy === 'composer'}
              className="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded">🚀 Sofort posten</button>
            {busy === 'composer' && <span className="text-xs text-gray-500">⏳ wird angelegt … (mit Bild-Generierung bis zu einer Minute)</span>}
          </div>
        </div>
      )}

      {error && <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-sm text-red-400">{error}</div>}
      {notice && (
        <div className="bg-emerald-500/10 border border-emerald-500/40 rounded px-3 py-2 text-sm text-emerald-300 flex items-start gap-2">
          <span className="flex-1 whitespace-pre-wrap">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-emerald-400 hover:text-emerald-200">✕</button>
        </div>
      )}
      {loading && <div className="text-gray-500 text-sm">Lade …</div>}

      {!loading && channels.length === 0 && (
        <div className="border border-dashed border-[#2a2a2a] rounded-lg p-10 text-center text-gray-500 text-sm">
          Noch keine Kanäle. Im Chat anlegen: „Lege einen Social-Kanal für … an" (Telegram-Kanal, eigene Plattform, YouTube, Instagram, Facebook, Threads, X).
        </div>
      )}

      {/* v1000 — Status-Kopfzeile: je Kanal Tages-Limit-Ampel + nächster Termin */}
      {channels.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          {channels.filter(c => c.status === 'active').map(c => {
            const today = c.publishedToday ?? publishedTodayByChannel[c.id] ?? 0;
            const atLimit = today >= c.maxPostsPerDay;
            const next = nextSlotByChannel[c.id];
            return (
              <button key={c.id} onClick={() => setChannelFilter(f => (f === c.id ? '' : c.id))}
                title={`${c.name}: heute ${today}/${c.maxPostsPerDay}${next ? ` · nächster Post ${fmtDateTime(next)}` : ''} — Klick filtert alle Ansichten`}
                className={clsx('px-2 py-1 rounded border flex items-center gap-1.5',
                  channelFilter === c.id ? 'border-blue-500/60 bg-blue-500/10 text-blue-200' : 'border-[#1f1f1f] text-gray-400 hover:bg-[#151515]')}>
                <span>{PLATFORM_ICON[c.platform] ?? '📣'}</span>
                <span className="max-w-[110px] truncate">{c.name}</span>
                <span className={clsx('px-1 rounded', atLimit ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/15 text-emerald-300')}>{today}/{c.maxPostsPerDay}</span>
                {next && <span className="text-gray-500">→ {new Date(next).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}{itemDayKey({ scheduledAt: next } as SocialContentItem) !== itemDayKey({ scheduledAt: new Date().toISOString() } as SocialContentItem) ? ` (${new Date(next).toLocaleDateString('de-AT', { weekday: 'short' })})` : ''}</span>}
              </button>
            );
          })}
          <div className="flex-1" />
          {(decisions.urgent.length + decisions.later.length) > 0 && (
            <span className="text-amber-300">✋ {decisions.urgent.length + decisions.later.length} warten auf dich</span>
          )}
          {decisions.failed.length > 0 && <span className="text-red-400">⚠ {decisions.failed.length} fehlgeschlagen</span>}
        </div>
      )}

      {/* v1000 — Seiten-Navigation */}
      {channels.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap border-b border-[#1f1f1f] pb-2">
          {(Object.keys(PAGE_LABEL) as QueueTab[]).map(p => (
            <button key={p} onClick={() => setPage(p)}
              className={clsx('px-3 py-1.5 text-sm rounded-t border-b-2', page === p ? 'border-blue-500 text-blue-300 bg-blue-500/5' : 'border-transparent text-gray-500 hover:text-gray-300')}>
              {PAGE_LABEL[p]}
              {p === 'decisions' && (decisions.urgent.length + decisions.later.length + decisions.failed.length) > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-amber-500/20 text-amber-300">{decisions.urgent.length + decisions.later.length + decisions.failed.length}</span>
              )}
            </button>
          ))}
          <div className="flex-1" />
          {channels.length > 1 && (
            <select value={channelFilter} onChange={e => setChannelFilter(e.target.value)}
              className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
              <option value="">Alle Kanäle</option>
              {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
      )}

      {/* v1000 — Entscheidungen: Triage-Board mit Bulk-Freigabe */}
      {page === 'decisions' && channels.length > 0 && (
        <div className="space-y-5">
          {selCount > 0 && (
            <div className="sticky top-2 z-40 flex items-center gap-2 bg-[#101418] border border-emerald-500/40 rounded-lg px-3 py-2 text-sm shadow-lg">
              <span className="text-emerald-300 font-medium">{selCount} ausgewählt</span>
              <button onClick={() => bulkAction('approve')} disabled={busy === 'bulk'}
                className="px-2.5 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded">
                {busy === 'bulk' ? '⏳ läuft …' : `✅ ${selCount} freigeben`}
              </button>
              <button onClick={() => bulkAction('reject')} disabled={busy === 'bulk'}
                className="px-2.5 py-1 text-xs border border-red-500/40 text-red-400 hover:bg-red-500/15 disabled:opacity-50 rounded">✕ ablehnen</button>
              <button onClick={() => setSel({})} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-300">Auswahl aufheben</button>
            </div>
          )}
          {decisions.failed.length > 0 && (
            <div>
              <div className="text-sm font-semibold text-red-300 mb-2">⚠️ Probleme ({decisions.failed.length}) <span className="text-gray-500 font-normal">— fehlgeschlagen, warten auf dich</span></div>
              <div className="space-y-2">{decisions.failed.map(i => renderItemCard(i, true))}</div>
            </div>
          )}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-semibold text-amber-300">🔴 Verfällt bald ({decisions.urgent.length})</span>
              <span className="text-[11px] text-gray-500">— Slot in weniger als 24h, ohne Freigabe passiert nichts</span>
              {decisions.urgent.length > 1 && (
                <button onClick={() => selectGroup(decisions.urgent, true)} className="text-[11px] text-blue-400 hover:text-blue-300">alle auswählen</button>
              )}
            </div>
            {decisions.urgent.length === 0 && <div className="text-xs text-gray-600">Nichts Dringendes — die nächsten 24 Stunden sind entschieden.</div>}
            <div className="space-y-2">{decisions.urgent.map(i => renderItemCard(i, true, true))}</div>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-semibold text-gray-200">🟡 Wartet auf Freigabe ({decisions.later.length})</span>
              {decisions.later.length > 1 && (
                <button onClick={() => selectGroup(decisions.later, true)} className="text-[11px] text-blue-400 hover:text-blue-300">alle auswählen</button>
              )}
            </div>
            {decisions.later.length === 0 && <div className="text-xs text-gray-600">Keine offenen Entwürfe.</div>}
            <div className="space-y-2">{decisions.later.map(i => renderItemCard(i, true, true))}</div>
          </div>
          <div>
            <div className="text-sm font-semibold text-emerald-300/90 mb-2">✅ Freigegeben & geplant ({decisions.approved.length}) <span className="text-gray-500 font-normal">— läuft von selbst, keine Aktion nötig</span></div>
            {decisions.approved.length === 0 && <div className="text-xs text-gray-600">Nichts freigegeben in der Warteschlange.</div>}
            <div className="space-y-2">{decisions.approved.map(i => renderItemCard(i, true))}</div>
          </div>
        </div>
      )}

      {/* Kanäle */}
      {page === 'channels' && channels.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {channels.map(c => (
            <div key={c.id} className={clsx('border rounded-lg p-4', c.status === 'active' ? 'border-[#1f1f1f]' : 'border-gray-500/30 opacity-70')}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xl">{PLATFORM_ICON[c.platform] ?? '📣'}</span>
                <span className="font-semibold text-gray-100">{c.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 bg-[#1a1a1a] text-gray-400 rounded uppercase">{c.platform}</span>
                <span className="text-[10px] px-1.5 py-0.5 bg-[#1a1a1a] text-gray-400 rounded uppercase">{c.publishMode}</span>
                {c.status !== 'active' && <span className="text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-300 rounded uppercase">{c.status}</span>}
              </div>
              <div className="text-[11px] text-gray-500 mt-1.5 space-x-2">
                <span className={clsx((c.publishedToday ?? publishedTodayByChannel[c.id] ?? 0) >= c.maxPostsPerDay && 'text-amber-400')}>
                  Heute {c.publishedToday ?? publishedTodayByChannel[c.id] ?? 0}/{c.maxPostsPerDay}
                </span>
                <span>· Horizont {c.planningHorizonDays}d</span>
                <span>· Erstpost-Streak {Math.min(c.approvedStreak, 5)}/5{c.approvedStreak >= 5 ? ' ✓' : ''}</span>
              </div>
              {/* v965 — effektive Slots + Bild-Budget auf einen Blick */}
              {c.effectiveSlots && (
                <div className="text-[11px] text-gray-500 mt-1">
                  🕐 {c.effectiveSlots.slots.join(' · ')}
                  <span className={clsx('ml-1.5 px-1 py-0.5 rounded text-[9px] uppercase', c.effectiveSlots.source === 'user' ? 'bg-blue-500/20 text-blue-300' : 'bg-purple-500/20 text-purple-300')}>
                    {c.effectiveSlots.source === 'user' ? 'eigene' : 'Best-Practice'}
                  </span>
                </div>
              )}
              {c.imageBudget && (
                <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-2">
                  🎨 Bild-Budget {c.imageBudget.used}/{c.imageBudget.total}
                  <span className="inline-block w-24 h-1.5 bg-[#1a1a1a] rounded overflow-hidden">
                    <span className={clsx('block h-full rounded', c.imageBudget.used >= c.imageBudget.total ? 'bg-red-500' : 'bg-emerald-500')}
                      style={{ width: `${Math.min(100, Math.round((c.imageBudget.used / Math.max(1, c.imageBudget.total)) * 100))}%` }} />
                  </span>
                </div>
              )}
              {/* v1020 — Kanalwachstum: Stand + Wochentrend */}
              {growth[c.id] && (
                <div className="text-[11px] text-gray-400 mt-1 flex items-center gap-2">
                  👥 {growth[c.id].latest.toLocaleString('de-AT')}
                  <span className={clsx(growth[c.id].delta7 > 0 ? 'text-emerald-400' : growth[c.id].delta7 < 0 ? 'text-red-400' : 'text-gray-500')}>
                    {growth[c.id].delta7 > 0 ? '+' : ''}{growth[c.id].delta7}/7d {growth[c.id].delta7 > 0 ? '▲' : growth[c.id].delta7 < 0 ? '▼' : ''}
                  </span>
                  {growth[c.id].series.length >= 2 && <Sparkline points={growth[c.id].series.map(s => s.value)} />}
                </div>
              )}
              {(c.topics?.length ?? 0) > 0 && (
                <div className="text-[11px] text-gray-500 mt-1">🧭 Themen: {c.topics!.map(t => t.name).join(', ')}</div>
              )}
              {channelMetricSummary(c.id) && (
                <div className="text-[11px] text-emerald-400 mt-1">📈 {channelMetricSummary(c.id)}</div>
              )}
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <select value={c.mode} onChange={e => setMode(c, e.target.value)} disabled={busy === c.id}
                  className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
                  {Object.entries(MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {c.mode === 'autonomous' && c.approvedStreak < 5 && (
                  <span className="text-[10px] text-amber-400" title="Erstpost-Sperre: erst 5 Freigaben ohne Korrektur">🔒 wirkt nach {5 - c.approvedStreak} Freigaben</span>
                )}
                <div className="flex-1" />
                <button onClick={() => (settingsId === c.id ? setSettingsId(null) : openSettings(c))} disabled={busy === c.id}
                  className={clsx('px-2 py-1 text-xs rounded border', settingsId === c.id ? 'border-blue-500/50 text-blue-300 bg-blue-500/10' : 'border-[#2a2a2a] text-gray-400 hover:bg-[#1a1a1a]')}>
                  ⚙️ Einstellungen
                </button>
                <button onClick={() => toggleChannelStatus(c)} disabled={busy === c.id}
                  className={clsx('px-2 py-1 text-xs rounded border',
                    c.status === 'active' ? 'border-gray-500/40 text-gray-400 hover:bg-gray-500/15' : 'border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15')}>
                  {c.status === 'active' ? '⏸ Pausieren' : '▶ Aktivieren'}
                </button>
              </div>
              {/* v965 — Kanal-Aktionen + Einstellungs-Panel */}
              {settingsId === c.id && (
                <div className="mt-3 pt-3 border-t border-[#1f1f1f] space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={() => channelAction(c, 'generate')} disabled={busy === `${c.id}:generate`}
                      title="Content-Studio sofort laufen lassen (kann mit Bildern einige Minuten dauern)"
                      className="px-2 py-1 text-xs border border-purple-500/40 text-purple-300 hover:bg-purple-500/15 disabled:opacity-50 rounded">
                      {busy === `${c.id}:generate` ? '⏳ Studio läuft …' : '✨ Studio jetzt'}
                    </button>
                    <button onClick={() => channelAction(c, 'replan')} disabled={busy === `${c.id}:replan`}
                      title="Bereits geplante Beiträge in die aktuellen Slots umverteilen"
                      className="px-2 py-1 text-xs border border-blue-500/40 text-blue-300 hover:bg-blue-500/15 disabled:opacity-50 rounded">📅 Beiträge umplanen</button>
                    <button onClick={() => channelAction(c, 'validate-auth')} disabled={busy === `${c.id}:validate-auth`}
                      className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 disabled:opacity-50 rounded">🔑 Auth prüfen</button>
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-500">Persona / Rolle (Ton, Länge, Blickwinkel — die Geschwister-Kanäle sehen sie als Rollenbeschreibung)</label>
                    <textarea value={settingsDraft.persona} onChange={e => setSettingsDraft(d => ({ ...d, persona: e.target.value }))} rows={3}
                      className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 mt-1" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-500">Posting-Slots (kommagetrennt, Ortszeit, z. B. „Mo 18:00, Sa 10:00" — leer = Plattform-Best-Practice inkl. Wochenende)</label>
                    <input value={settingsDraft.slots} onChange={e => setSettingsDraft(d => ({ ...d, slots: e.target.value }))}
                      placeholder={c.effectiveSlots?.source === 'best-practice' ? `Best-Practice aktiv: ${c.effectiveSlots.slots.join(', ')}` : ''}
                      className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 mt-1" />
                    <div className="text-[10px] text-gray-600 mt-0.5">Nach Slot-Änderung „Beiträge umplanen" klicken, damit Bestandstermine mitziehen.</div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div>
                      <label className="text-[11px] text-gray-500">Posts/Tag</label>
                      <input type="number" min={1} value={settingsDraft.maxPostsPerDay} onChange={e => setSettingsDraft(d => ({ ...d, maxPostsPerDay: Number(e.target.value) }))}
                        className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                    </div>
                    <div>
                      <label className="text-[11px] text-gray-500">Horizont (Tage)</label>
                      <input type="number" min={1} value={settingsDraft.planningHorizonDays} onChange={e => setSettingsDraft(d => ({ ...d, planningHorizonDays: Number(e.target.value) }))}
                        className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                    </div>
                    <div>
                      <label className="text-[11px] text-gray-500">Bild-Budget/Monat</label>
                      <input type="number" min={0} value={settingsDraft.imageBudgetTotal} onChange={e => setSettingsDraft(d => ({ ...d, imageBudgetTotal: Number(e.target.value) }))}
                        className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                    </div>
                    <div className="flex items-end pb-1">
                      <label className="text-[11px] text-gray-400 flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={settingsDraft.generateImages} onChange={e => setSettingsDraft(d => ({ ...d, generateImages: e.target.checked }))} />
                        Bilder generieren
                      </label>
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-500">Text-Modell (LLM-Qualität für die Content-Erzeugung dieses Kanals)</label>
                    <select value={settingsDraft.modelTier} onChange={e => setSettingsDraft(d => ({ ...d, modelTier: e.target.value }))}
                      className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 mt-1">
                      <option value="fast">fast — Standard, günstig (kurze Community-Posts)</option>
                      <option value="medium">medium — hochwertige Serienproduktion (Redaktionstexte)</option>
                      <option value="default">default — Alltagsmodell des Assistenten</option>
                      <option value="strong">strong — Topmodell (höchste Qualität, teuer)</option>
                    </select>
                  </div>
                  {/* v1012 — Serien-Formate: wiederkehrende Wochen-Formate */}
                  <div className="border border-amber-500/20 rounded p-2.5 space-y-2 bg-amber-500/5">
                    <div className="text-[11px] font-medium text-amber-300">📆 Serien-Formate <span className="text-gray-500 font-normal">— erscheinen zuverlässig jede Woche zum Slot (z. B. Wochenrückblick Mo 09:00)</span></div>
                    {settingsDraft.formate.map((f, idx) => (
                      <div key={idx} className="grid grid-cols-[90px_1fr_auto] gap-1.5 items-start">
                        <input value={f.slot} placeholder="Mo 09:00"
                          onChange={e => setSettingsDraft(d => ({ ...d, formate: d.formate.map((x, i) => (i === idx ? { ...x, slot: e.target.value } : x)) }))}
                          className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200" />
                        <div className="space-y-1">
                          <input value={f.name} placeholder="Format-Name, z. B. Wochenrückblick"
                            onChange={e => setSettingsDraft(d => ({ ...d, formate: d.formate.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)) }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200" />
                          <input value={f.anweisung} placeholder="Redaktions-Anweisung, z. B.: Fasse die Fußball-Woche in 5 Punkten zusammen"
                            onChange={e => setSettingsDraft(d => ({ ...d, formate: d.formate.map((x, i) => (i === idx ? { ...x, anweisung: e.target.value } : x)) }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200" />
                        </div>
                        <button onClick={() => setSettingsDraft(d => ({ ...d, formate: d.formate.filter((_, i) => i !== idx) }))}
                          className="text-red-400 hover:text-red-300 text-xs px-1 py-1" title="Format entfernen">✕</button>
                      </div>
                    ))}
                    {settingsDraft.formate.length < 7 && (
                      <button onClick={() => setSettingsDraft(d => ({ ...d, formate: [...d.formate, { slot: '', name: '', anweisung: '' }] }))}
                        className="px-2 py-1 text-[11px] border border-amber-500/40 text-amber-300 hover:bg-amber-500/15 rounded">+ Format hinzufügen</button>
                    )}
                  </div>
                  {/* v1006 — Sprache des Kanals + Übersetzungen (Website-Kanäle) */}
                  <div className="border border-emerald-500/20 rounded p-2.5 space-y-2 bg-emerald-500/5">
                    <div className="text-[11px] font-medium text-emerald-300">🌍 Sprache</div>
                    <div className="grid grid-cols-2 gap-2 items-start">
                      <div>
                        <label className="text-[11px] text-gray-500">Inhaltssprache (alle Beiträge dieses Kanals)</label>
                        <select value={settingsDraft.language} onChange={e => setSettingsDraft(d => ({ ...d, language: e.target.value }))}
                          className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1">
                          {LANGS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                        </select>
                      </div>
                      {c.platform === 'rest' && (
                        <div>
                          <label className="text-[11px] text-gray-500" title="Beim Veröffentlichen übersetzt Alfred Titel+Text und legt sie als translations ins Payload — die Plattform zeigt sie als Sprachversionen.">Übersetzen nach (Website-Sprachversionen)</label>
                          <div className="flex items-center gap-2 flex-wrap mt-1.5">
                            {LANGS.filter(([code]) => code !== settingsDraft.language).map(([code, name]) => (
                              <label key={code} className="text-[11px] text-gray-300 flex items-center gap-1 cursor-pointer">
                                <input type="checkbox" checked={settingsDraft.translateTo.includes(code)}
                                  onChange={e => setSettingsDraft(d => ({
                                    ...d,
                                    translateTo: e.target.checked ? [...d.translateTo, code] : d.translateTo.filter(l => l !== code),
                                  }))} />
                                {name}
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    {c.platform === 'rest' && settingsDraft.translateTo.length > 0 && (
                      <div className="text-[10px] text-gray-600">Übersetzungen entstehen beim Veröffentlichen (LLM, best-effort — schlägt sie fehl, erscheint der Artikel vorerst einsprachig). Die Plattform muss Sprachversionen unterstützen.</div>
                    )}
                  </div>
                  {/* v1007 — IG-Auto-Story */}
                  {c.platform === 'instagram' && (
                    <label className="text-[11px] text-gray-400 flex items-center gap-1.5 cursor-pointer"
                      title="Sobald der Lead-Artikel der Familie live geht, postet dieser Kanal automatisch eine Story (9:16-Bild des Feed-Posts mit Titel + Link-im-Profil-CTA). Zählt aufs Tages-Limit.">
                      <input type="checkbox" checked={settingsDraft.autoStory} onChange={e => setSettingsDraft(d => ({ ...d, autoStory: e.target.checked }))} />
                      📱 Auto-Story bei neuem Lead-Artikel (geht OHNE Einzelfreigabe live)
                    </label>
                  )}
                  {/* v1008 — IG-Karussells */}
                  {c.platform === 'instagram' && settingsDraft.generateImages && (
                    <label className="text-[11px] text-gray-400 flex items-center gap-1.5 cursor-pointer"
                      title="Bei Aufzählungen/Analysen erzeugt das Studio 2-4 Slides mit Titel-Overlays statt eines Einzelbilds. Jeder Slide zählt aufs Bild-Budget; die Bild-Bibliothek dämpft die Kosten.">
                      <input type="checkbox" checked={settingsDraft.imageCarousel} onChange={e => setSettingsDraft(d => ({ ...d, imageCarousel: e.target.checked }))} />
                      🎠 Karussells (2-4 Slides bei Analysen/Aufzählungen)
                    </label>
                  )}
                  {/* v1016/v1060 — Reels & Video: Auto-Reel + Musik-Bett + KI-Clips (Stufe 3) */}
                  {c.platform === 'instagram' && (
                    <div className="border border-purple-500/20 rounded p-2.5 space-y-2 bg-purple-500/5">
                      <div className="text-[11px] font-medium text-purple-300">🎬 Reels &amp; Video <span className="text-gray-500 font-normal">— Sprecher, Untertitel, Hook + End-Card kommen automatisch</span></div>
                      <label className="text-[11px] text-gray-400 flex items-center gap-1.5 cursor-pointer"
                        title="Beim Lead-Artikel entsteht ein 20-30s-Reel (Sprecher, Untertitel, Bilder der Story) als ENTWURF — geht erst nach deiner Freigabe live. Braucht ffmpeg auf dem Host.">
                        <input type="checkbox" checked={settingsDraft.autoReel} onChange={e => setSettingsDraft(d => ({ ...d, autoReel: e.target.checked }))} />
                        Auto-Reel bei neuem Lead-Artikel (als Entwurf, mit Freigabe)
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[11px] text-gray-500">Max. Reels pro Woche</label>
                          <input type="number" min={0} max={14} value={settingsDraft.reelMaxPerWeek}
                            onChange={e => setSettingsDraft(d => ({ ...d, reelMaxPerWeek: Math.max(0, Number(e.target.value) || 0) }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                        </div>
                        <div>
                          <label className="text-[11px] text-gray-500">End-Card-Text (CTA)</label>
                          <input value={settingsDraft.reelCtaText} onChange={e => setSettingsDraft(d => ({ ...d, reelCtaText: e.target.value }))}
                            placeholder="automatisch: „Ganzer Artikel auf <Marke>“"
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 items-end">
                        <label className="text-[11px] text-gray-400 flex items-center gap-1.5 cursor-pointer pb-1"
                          title="Leises lizenzfreies Musik-Bett unterm Sprecher (weicht der Stimme automatisch aus). Tracks liegen serverseitig im Ordner reel-music des Datenverzeichnisses.">
                          <input type="checkbox" checked={settingsDraft.reelMusicOn} onChange={e => setSettingsDraft(d => ({ ...d, reelMusicOn: e.target.checked }))} />
                          🎵 Musik-Bett
                        </label>
                        {settingsDraft.reelMusicOn && (
                          <div>
                            <label className="text-[11px] text-gray-500">Musik-Lautstärke (0–1, leer = 0,15)</label>
                            <input value={settingsDraft.reelMusicVolume} onChange={e => setSettingsDraft(d => ({ ...d, reelMusicVolume: e.target.value }))}
                              placeholder="0.15"
                              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                          </div>
                        )}
                      </div>
                      {/* v1066 — Dauer-Branding im Video (TV-Bug-Stil) */}
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[11px] text-gray-500" title="Standard: Branding erscheint nur auf Hook-Karte und End-Card (blendet mit über). Aktiviert: Wasserzeichen-Text und/oder Kanal-Logo bleiben über das GESAMTE Video eingeblendet (wie ein TV-Sender-Logo).">📍 Dauer-Branding im Video</label>
                          <select value={settingsDraft.reelWatermark} onChange={e => setSettingsDraft(d => ({ ...d, reelWatermark: e.target.value as 'aus' | 'text' | 'logo' | 'both' }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1">
                            <option value="aus">aus — nur auf Hook + End-Card (Standard)</option>
                            <option value="text">Wasserzeichen-Text dauerhaft</option>
                            <option value="logo">Logo dauerhaft</option>
                            <option value="both">Text + Logo dauerhaft</option>
                          </select>
                        </div>
                        {settingsDraft.reelWatermark === 'both' && (
                          <div>
                            <label className="text-[11px] text-gray-500" title="Block: Logo mit Text darunter als eine Einheit. Angeglichen: zusätzlich wird der Text exakt auf die Logo-Breite skaliert. Getrennt: Text und Logo bekommen je eine eigene Ecke (wie bei den Bildern).">Anordnung</label>
                            <select value={settingsDraft.reelWatermarkLayout} onChange={e => setSettingsDraft(d => ({ ...d, reelWatermarkLayout: e.target.value as 'stack' | 'stack_fit' | 'split' }))}
                              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1">
                              <option value="stack">Block — Logo über Text</option>
                              <option value="stack_fit">Block — Text auf Logo-Breite angeglichen</option>
                              <option value="split">getrennt positionieren</option>
                            </select>
                          </div>
                        )}
                        {settingsDraft.reelWatermark !== 'aus' && (
                          <div>
                            <label className="text-[11px] text-gray-500">{settingsDraft.reelWatermark === 'both' && settingsDraft.reelWatermarkLayout === 'split' ? 'Position Text' : 'Position'}</label>
                            <select value={settingsDraft.reelWatermarkCorner} onChange={e => setSettingsDraft(d => ({ ...d, reelWatermarkCorner: e.target.value }))}
                              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1">
                              <option value="bottom-right">unten rechts</option>
                              <option value="bottom-left">unten links</option>
                              <option value="top-right">oben rechts</option>
                              <option value="top-left">oben links</option>
                            </select>
                          </div>
                        )}
                        {settingsDraft.reelWatermark === 'both' && settingsDraft.reelWatermarkLayout === 'split' && (
                          <div>
                            <label className="text-[11px] text-gray-500">Position Logo</label>
                            <select value={settingsDraft.reelWatermarkLogoCorner} onChange={e => setSettingsDraft(d => ({ ...d, reelWatermarkLogoCorner: e.target.value }))}
                              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1">
                              <option value="top-left">oben links</option>
                              <option value="top-right">oben rechts</option>
                              <option value="bottom-left">unten links</option>
                              <option value="bottom-right">unten rechts</option>
                            </select>
                          </div>
                        )}
                      </div>
                      <div className="border-t border-purple-500/10 pt-2 space-y-2">
                        <div>
                          <label className="text-[11px] text-gray-500" title="Die ersten 1-2 Bilder des Reels werden per Image-to-Video in echte bewegte Clips verwandelt (5-8s). KOSTET je Clip ca. 0,25-3 € beim gewählten Anbieter; Fehlschläge fallen automatisch auf die Ken-Burns-Standbilder zurück.">✨ KI-Video-Clips (Stufe 3 — kostenpflichtig je Clip)</label>
                          <select value={settingsDraft.reelAiClips} onChange={e => setSettingsDraft(d => ({ ...d, reelAiClips: Number(e.target.value) as 0 | 1 | 2 }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1">
                            <option value={0}>aus — Ken-Burns-Standbilder (wie bisher, kostenlos)</option>
                            <option value={1}>1 Clip je Reel (Hook-Szene bewegt)</option>
                            <option value={2}>2 Clips je Reel</option>
                          </select>
                        </div>
                        {settingsDraft.reelAiClips > 0 && (
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                            <div>
                              <label className="text-[11px] text-gray-500">Anbieter</label>
                              <select value={settingsDraft.reelAiProvider} onChange={e => setSettingsDraft(d => ({ ...d, reelAiProvider: e.target.value as 'sora' | 'runway' | 'veo' }))}
                                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1">
                                <option value="sora">Sora (OpenAI-Key, ~0,80 €/Clip)</option>
                                <option value="runway">Runway (Secret RUNWAY_API_SECRET, ~0,25 €)</option>
                                <option value="veo">Veo (Secret GOOGLE_API_KEY, ~1-3 €)</option>
                              </select>
                            </div>
                            <div>
                              <label className="text-[11px] text-gray-500">Clip-Budget/Monat</label>
                              <input type="number" min={0} value={settingsDraft.aiClipBudget}
                                onChange={e => setSettingsDraft(d => ({ ...d, aiClipBudget: Math.max(0, Number(e.target.value) || 0) }))}
                                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                            </div>
                            <div>
                              <label className="text-[11px] text-gray-500">Modell (leer = Standard)</label>
                              <input value={settingsDraft.reelAiModel} onChange={e => setSettingsDraft(d => ({ ...d, reelAiModel: e.target.value }))}
                                placeholder={settingsDraft.reelAiProvider === 'sora' ? 'sora-2' : settingsDraft.reelAiProvider === 'runway' ? 'gen4_turbo' : 'veo-3.1-fast-generate-preview'}
                                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {/* v1056/v1060 — FB-Reel-Zweitverwertung */}
                  {c.platform === 'facebook' && (
                    <label className="text-[11px] text-gray-400 flex items-center gap-1.5 cursor-pointer"
                      title="Das auf Instagram gerenderte Auto-Reel derselben Familie wird als zweiter Entwurf für diese Facebook-Page angelegt (gleiche Videodatei, kein doppeltes Rendering, gleiche Freigabe-Pflicht).">
                      <input type="checkbox" checked={settingsDraft.autoReel} onChange={e => setSettingsDraft(d => ({ ...d, autoReel: e.target.checked }))} />
                      🎬 IG-Auto-Reel auch als Facebook-Reel übernehmen (Entwurf mit Freigabe)
                    </label>
                  )}
                  {/* v1004 — Bild-Look: Stil-Preset, Qualität, Wasserzeichen, Titel-Overlay */}
                  {settingsDraft.generateImages && (
                    <div className="border border-blue-500/20 rounded p-2.5 space-y-2 bg-blue-500/5">
                      <div className="text-[11px] font-medium text-blue-300">🎨 Bild-Look <span className="text-gray-500 font-normal">— gilt für alle generierten Bilder dieses Kanals</span></div>
                      <div>
                        <label className="text-[11px] text-gray-500">Stil-Preset (wird an jeden Bild-Prompt angehängt — gleicher Look, verschiedene Motive; leer = Persona)</label>
                        <input value={settingsDraft.imageStyle} onChange={e => setSettingsDraft(d => ({ ...d, imageStyle: e.target.value }))}
                          placeholder='z.B. "cinematisch, natürliches Licht, satte Grüntöne, 35mm-Fotografie"'
                          className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 mt-1" />
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
                        <div>
                          <label className="text-[11px] text-gray-500">Qualität</label>
                          <select value={settingsDraft.imageQuality} onChange={e => setSettingsDraft(d => ({ ...d, imageQuality: e.target.value as 'default' | 'low' | 'medium' | 'high' }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1">
                            <option value="default">Standard</option>
                            <option value="low">low — günstig</option>
                            <option value="medium">medium</option>
                            <option value="high">high — beste Qualität, teuer</option>
                          </select>
                        </div>
                        <div className="col-span-2 md:col-span-1">
                          <label className="text-[11px] text-gray-500">Wasserzeichen-Text</label>
                          <input value={settingsDraft.imageBranding} onChange={e => setSettingsDraft(d => ({ ...d, imageBranding: e.target.value }))}
                            placeholder="automatisch: Lead-Domain"
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                        </div>
                        <label className="text-[11px] text-gray-400 flex items-center gap-1.5 cursor-pointer pb-1">
                          <input type="checkbox" checked={settingsDraft.watermarkOn} onChange={e => setSettingsDraft(d => ({ ...d, watermarkOn: e.target.checked }))} />
                          Wasserzeichen
                        </label>
                        <label className="text-[11px] text-gray-400 flex items-center gap-1.5 cursor-pointer pb-1" title="Post-Titel als Nachrichten-Boxen unten links auf dem Bild (Termine bekommen immer ihre Termin-Karte)">
                          <input type="checkbox" checked={settingsDraft.titleOverlayOn} onChange={e => setSettingsDraft(d => ({ ...d, titleOverlayOn: e.target.checked }))} />
                          Titel aufs Bild
                        </label>
                      </div>
                      {/* v1026 — Ecken + Logo-Wasserzeichen (SVG) */}
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 items-end">
                        <div>
                          <label className="text-[11px] text-gray-500">Text-Ecke</label>
                          <select value={settingsDraft.watermarkCorner} onChange={e => setSettingsDraft(d => ({ ...d, watermarkCorner: e.target.value }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1">
                            <option value="bottom-right">unten rechts</option>
                            <option value="bottom-left">unten links</option>
                            <option value="top-right">oben rechts</option>
                            <option value="top-left">oben links</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[11px] text-gray-500">Logo (SVG){settingsDraft.logoSvg ? ' — ✅ gesetzt' : ''}</label>
                          <input type="file" accept=".svg,image/svg+xml"
                            onChange={e => {
                              const f = e.target.files?.[0];
                              if (!f) return;
                              if (f.size > 200_000) { setError('Logo-SVG ist zu groß (max. 200 KB).'); return; }
                              f.text().then(txt => {
                                if (!txt.trim().startsWith('<svg') && !txt.includes('<svg')) { setError('Datei ist kein SVG.'); return; }
                                setSettingsDraft(d => ({ ...d, logoSvg: txt }));
                              });
                            }}
                            className="w-full text-[10px] text-gray-400 mt-1" />
                        </div>
                        <div className="flex items-end gap-2">
                          <div className="flex-1">
                            <label className="text-[11px] text-gray-500">Logo-Ecke</label>
                            <select value={settingsDraft.logoCorner} onChange={e => setSettingsDraft(d => ({ ...d, logoCorner: e.target.value }))}
                              disabled={!settingsDraft.logoSvg}
                              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1 disabled:opacity-40">
                              <option value="bottom-right">unten rechts</option>
                              <option value="bottom-left">unten links</option>
                              <option value="top-right">oben rechts</option>
                              <option value="top-left">oben links</option>
                            </select>
                          </div>
                          {/* v1032 — Logo-Farbe: umfärbt das SVG beim Compositing; „↺" = Originalfarben */}
                          <div>
                            <label className="text-[11px] text-gray-500">Farbe{settingsDraft.logoColor ? '' : ' (Original)'}</label>
                            <div className="flex items-center gap-1 mt-1">
                              <input type="color" value={settingsDraft.logoColor || '#ffffff'}
                                onChange={e => setSettingsDraft(d => ({ ...d, logoColor: e.target.value }))}
                                disabled={!settingsDraft.logoSvg}
                                className="h-6 w-9 bg-[#0a0a0a] border border-[#2a2a2a] rounded cursor-pointer disabled:opacity-40"
                                title="Logo umfärben (gilt je Kanal — ein SVG reicht für alle Farben)" />
                              {settingsDraft.logoColor && (
                                <button onClick={() => setSettingsDraft(d => ({ ...d, logoColor: '' }))}
                                  className="px-1.5 py-0.5 text-[10px] border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded" title="Originalfarben des SVG verwenden">↺</button>
                              )}
                            </div>
                          </div>
                          {settingsDraft.logoSvg && (
                            <button onClick={() => setSettingsDraft(d => ({ ...d, logoSvg: '' }))}
                              className="px-2 py-1 text-[10px] border border-red-500/40 text-red-400 hover:bg-red-500/15 rounded" title="Logo entfernen">✕</button>
                          )}
                        </div>
                      </div>
                      {/* v1041 — Termin-Vorlage: festes Basis-Bild für alle Termin-Posts, Daten kommen aus der Termin-Karte */}
                      <div className="border-t border-[#2a2a2a] pt-2 space-y-1.5">
                        <div className="text-[11px] font-medium text-gray-300">📅 Termin-Vorlage <span className="text-gray-500 font-normal">— festes Bild für Termin-Ankündigungen (kein Budget); leer = generieren wie bisher</span></div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <select value={settingsDraft.terminImage} onChange={e => setSettingsDraft(d => ({ ...d, terminImage: e.target.value }))}
                            className="flex-1 min-w-[200px] bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
                            <option value="">— kein Vorlagenbild (generieren) —</option>
                            {assets.filter(a => !a.blocked).map(a => (
                              <option key={a.id} value={a.id}>{a.pinned ? '📌 ' : ''}{a.motif.slice(0, 70)}</option>
                            ))}
                          </select>
                          <input type="file" accept="image/png,image/jpeg"
                            onChange={e => {
                              const f = e.target.files?.[0];
                              if (!f) return;
                              if (f.size > 8_000_000) { setError('Bild ist zu groß (max. 8 MB).'); return; }
                              const reader = new FileReader();
                              reader.onload = async () => {
                                try {
                                  const r = await client!.socialUploadAsset(String(reader.result), `Termin-Vorlage: ${f.name}`);
                                  if (!r.success || !r.data) throw new Error(r.error ?? 'Upload fehlgeschlagen');
                                  setSettingsDraft(d => ({ ...d, terminImage: r.data!.id }));
                                  setNotice('Termin-Vorlage hochgeladen (gepinnt in der Bibliothek) — Speichern nicht vergessen.');
                                  await loadAssets();
                                } catch (err) { setError((err as Error).message); }
                              };
                              reader.readAsDataURL(f);
                            }}
                            className="text-[10px] text-gray-400 max-w-[190px]" title="Eigenes Vorlagenbild hochladen (PNG/JPEG, landet gepinnt in der Bibliothek)" />
                          {settingsDraft.terminImage && (
                            <button onClick={async () => {
                                if (!confirm('Diese Termin-Vorlage für ALLE Kanäle übernehmen?')) return;
                                await withBusy('termin-template-all', async () => {
                                  for (const ch of channels) {
                                    await client!.updateSocialChannel(ch.id, { config: { image_overlay: { termin_image: settingsDraft.terminImage } } });
                                  }
                                  await client!.socialAssetAction(settingsDraft.terminImage, 'pin').catch(() => {});
                                  setNotice(`📅 Termin-Vorlage auf ${channels.length} Kanäle übernommen.`);
                                  await load();
                                });
                              }}
                              disabled={busy === 'termin-template-all'}
                              className="px-2 py-1 text-[10px] border border-purple-500/40 text-purple-300 hover:bg-purple-500/15 disabled:opacity-50 rounded"
                              title="Setzt image_overlay.termin_image auf allen Kanälen und pinnt das Bild">
                              {busy === 'termin-template-all' ? '⏳' : 'Für ALLE Kanäle'}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="text-[10px] text-gray-600">Format automatisch: Instagram Hochformat (4:5), Website/FB/Telegram Querformat. Termin-Posts bekommen eine Termin-Karte (Anpfiff, Einlass, Ort) — Text immer aus den Daten, nie vom Bildmodell. Logo und Text-Wasserzeichen sind kombinierbar (je eigene Ecke); liegt das Logo unten rechts, wandert der Text automatisch nach unten links. Nach Look-Änderungen: „🖌️ Overlays neu" in der Bild-Bibliothek wendet den neuen Stil auf alle wartenden Beiträge an.</div>
                    </div>
                  )}
                  {/* v996 — Familien-Playbook: Rolle, Staging-Versatz, Eilmeldungs-Regeln */}
                  {familyKeyOf(c) && (
                    <div className="border border-purple-500/20 rounded p-2.5 space-y-2 bg-purple-500/5">
                      <div className="text-[11px] font-medium text-purple-300">📖 Familien-Playbook <span className="text-gray-500 font-normal">— gilt für die Redaktionskonferenz und den News-Desk dieser Kanal-Familie</span></div>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                        <div>
                          <label className="text-[11px] text-gray-500">Familienrolle</label>
                          <select value={settingsDraft.familyRole} onChange={e => setSettingsDraft(d => ({ ...d, familyRole: e.target.value as 'auto' | 'lead' | 'follow' }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1">
                            <option value="auto">auto — Konferenz entscheidet</option>
                            <option value="lead">lead — immer der ausführlichste Erstbeitrag</option>
                            <option value="follow">follow — folgt dem Lead</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[11px] text-gray-500">Staging-Versatz (h nach Lead)</label>
                          <input type="number" min={0} max={72} value={settingsDraft.familyOffset} placeholder="Konferenz entscheidet"
                            onChange={e => setSettingsDraft(d => ({ ...d, familyOffset: e.target.value }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                        </div>
                        <div>
                          <label className="text-[11px] text-gray-500" title="Follower-Posts verlinken den Lead-Artikel automatisch (mit UTM). Teaser: Post verrät nicht alles — die Pointe bleibt im Artikel.">Traffic-Modus (Follower)</label>
                          <select value={settingsDraft.trafficMode} onChange={e => setSettingsDraft(d => ({ ...d, trafficMode: e.target.value as 'voll' | 'teaser' | 'auto' }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1">
                            <option value="voll">voll — vollwertiger Beitrag + Link</option>
                            <option value="teaser">teaser — Neugier-Lücke, Pointe im Artikel</option>
                            <option value="auto">auto — News/Recaps als Teaser, Rest voll</option>
                          </select>
                        </div>
                      </div>
                      <div className="text-[10px] text-gray-500">Eilmeldungs-Regeln (News-Desk liest sie vom Lead-Kanal):</div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        <div>
                          <label className="text-[11px] text-gray-500">Ruhe von (Uhr)</label>
                          <input type="number" min={0} max={24} value={settingsDraft.quietFrom} onChange={e => setSettingsDraft(d => ({ ...d, quietFrom: Number(e.target.value) }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                        </div>
                        <div>
                          <label className="text-[11px] text-gray-500">Ruhe bis (Uhr)</label>
                          <input type="number" min={0} max={24} value={settingsDraft.quietTo} onChange={e => setSettingsDraft(d => ({ ...d, quietTo: Number(e.target.value) }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                        </div>
                        <div>
                          <label className="text-[11px] text-gray-500">Schwelle (0..1)</label>
                          <input type="number" min={0} max={1} step={0.05} value={settingsDraft.newsdeskThreshold} onChange={e => setSettingsDraft(d => ({ ...d, newsdeskThreshold: Number(e.target.value) }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                        </div>
                        <div>
                          <label className="text-[11px] text-gray-500">Eilmeldungen/Tag</label>
                          <input type="number" min={0} max={10} value={settingsDraft.newsdeskMaxPerDay} onChange={e => setSettingsDraft(d => ({ ...d, newsdeskMaxPerDay: Number(e.target.value) }))}
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200 mt-1" />
                        </div>
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="text-[11px] text-gray-500">Blacklist / Tabu-Themen (kommagetrennt)</label>
                    <input value={settingsDraft.blacklist} onChange={e => setSettingsDraft(d => ({ ...d, blacklist: e.target.value }))}
                      className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 mt-1" />
                  </div>
                  {/* Themen verknüpfen/lösen */}
                  <div>
                    <label className="text-[11px] text-gray-500">Interessen-Themen (speisen das Content-Studio)</label>
                    <div className="flex items-center gap-1.5 flex-wrap mt-1">
                      {(c.topics ?? []).map(t => (
                        <span key={t.id} className="text-[11px] px-1.5 py-0.5 bg-[#1a1a1a] text-gray-300 rounded flex items-center gap-1">
                          {t.name}
                          <button onClick={() => channelAction(c, 'unlink-topic', { topic: t.name })} disabled={busy === `${c.id}:unlink-topic`}
                            className="text-red-400 hover:text-red-300" title="Thema lösen">✕</button>
                        </span>
                      ))}
                      {interestTopics.filter(t => !(c.topics ?? []).some(l => l.id === t.id)).length > 0 && (
                        <>
                          <select value={linkTopicSel} onChange={e => setLinkTopicSel(e.target.value)}
                            className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-1.5 py-0.5 text-[11px] text-gray-200">
                            <option value="">Thema wählen …</option>
                            {interestTopics.filter(t => !(c.topics ?? []).some(l => l.id === t.id)).map(t => (
                              <option key={t.id} value={t.name}>{t.name}</option>
                            ))}
                          </select>
                          <button onClick={() => linkTopicSel && channelAction(c, 'link-topic', { topic: linkTopicSel })}
                            disabled={!linkTopicSel || busy === `${c.id}:link-topic`}
                            className="px-1.5 py-0.5 text-[11px] border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15 disabled:opacity-40 rounded">+ verknüpfen</button>
                        </>
                      )}
                    </div>
                  </div>
                  {/* v969 — Medien-Ablageort (für Instagram/Meta: Plattform holt Medien per öffentlicher URL) */}
                  {['instagram', 'facebook', 'threads'].includes(c.platform) && (
                    <div className="text-[11px] text-gray-500">
                      🌐 Medien-Ablageort (public_media): {(() => {
                        const pm = c.config.public_media as { provider?: string; base_url?: string; endpoint?: string; bucket?: string } | undefined;
                        if (pm?.provider === 'rest' && pm.base_url) return `Medienbibliothek ${pm.base_url}`;
                        if (pm?.provider === 's3' && pm.endpoint) return `S3-Bucket ${pm.endpoint}/${pm.bucket ?? ''}`;
                        return '⚠️ nicht konfiguriert — generierte Bilder können nicht gepostet werden (per Chat: „Aktualisiere den Kanal … config public_media")';
                      })()}
                    </div>
                  )}
                  {/* Lektionen */}
                  <div>
                    <label className="text-[11px] text-gray-500">📚 Lektionen (fließen zwingend in jeden Studio-Lauf ein)</label>
                    <div className="space-y-1 mt-1">
                      {settingsDraft.lessons.map((l, idx) => (
                        <div key={idx} className="flex items-start gap-1.5 text-[11px] text-gray-300">
                          <span className="flex-1">• {l}</span>
                          <button onClick={() => setSettingsDraft(d => ({ ...d, lessons: d.lessons.filter((_, i) => i !== idx) }))}
                            className="text-red-400 hover:text-red-300" title="Lektion entfernen">✕</button>
                        </div>
                      ))}
                      <input value={settingsDraft.newLesson} onChange={e => setSettingsDraft(d => ({ ...d, newLesson: e.target.value }))}
                        placeholder='Neue Lektion, z. B. „Es ist die WM 2026, nicht die EM — auch in Hashtags"'
                        className="w-full bg-[#0a0a0a] border border-purple-500/30 rounded px-2 py-1 text-[11px] text-purple-200" />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => saveSettings(c)} disabled={busy === c.id}
                      className="px-2.5 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded">✓ Einstellungen speichern</button>
                    <button onClick={() => setSettingsId(null)}
                      className="px-2.5 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded">Abbrechen</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* v1015 — Kanal-Wizard */}
      {page === 'channels' && (
        <div className="border border-emerald-500/20 rounded-lg p-4">
          <button onClick={() => setWizardOpen(o => !o)} className="w-full text-left flex items-center gap-2">
            <span className="text-sm font-semibold text-emerald-300">➕ Neuer Kanal</span>
            <span className="text-[11px] text-gray-500">— geführt anlegen (Plattform, Pflichtfelder, Secrets-Hinweise)</span>
            <div className="flex-1" />
            <span className="text-gray-500 text-xs">{wizardOpen ? '▲' : '▼'}</span>
          </button>
          {wizardOpen && (
            <div className="mt-3 space-y-2">
              <div className="grid md:grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-gray-500">Plattform</label>
                  <select value={wizard.platform} onChange={e => setWizard(w => ({ ...w, platform: e.target.value, fields: {} }))}
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 mt-1">
                    {Object.entries(PLATFORM_WIZARD).map(([p, m]) => <option key={p} value={p}>{m.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-gray-500">Kanal-Name</label>
                  <input value={wizard.name} onChange={e => setWizard(w => ({ ...w, name: e.target.value }))} placeholder="z. B. FussballCC Bluesky"
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 mt-1" />
                </div>
              </div>
              {(PLATFORM_WIZARD[wizard.platform]?.fields ?? []).length > 0 && (
                <div className="grid md:grid-cols-2 gap-2">
                  {PLATFORM_WIZARD[wizard.platform].fields.map(f => (
                    <div key={f.key}>
                      <label className="text-[11px] text-gray-500">{f.label}</label>
                      <input value={wizard.fields[f.key] ?? ''} onChange={e => setWizard(w => ({ ...w, fields: { ...w.fields, [f.key]: e.target.value } }))}
                        placeholder={f.placeholder}
                        className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 mt-1" />
                    </div>
                  ))}
                </div>
              )}
              <div className="text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
                🔑 {PLATFORM_WIZARD[wizard.platform]?.hint}
              </div>
              <div className="grid md:grid-cols-3 gap-2">
                <div>
                  <label className="text-[11px] text-gray-500">Modus</label>
                  <select value={wizard.mode} onChange={e => setWizard(w => ({ ...w, mode: e.target.value }))}
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 mt-1">
                    {Object.entries(MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-gray-500">Publish</label>
                  <select value={wizard.publishMode} onChange={e => setWizard(w => ({ ...w, publishMode: e.target.value }))}
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 mt-1">
                    <option value="api">api — Alfred postet selbst</option>
                    <option value="prepare">prepare — Alfred bereitet nur auf</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-gray-500">Projekt (optional — Familien-Bindung)</label>
                  <input value={wizard.project} onChange={e => setWizard(w => ({ ...w, project: e.target.value }))} placeholder="Projekt-Name"
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 mt-1" />
                </div>
              </div>
              <div>
                <label className="text-[11px] text-gray-500">Persona / Rolle (optional)</label>
                <textarea value={wizard.persona} onChange={e => setWizard(w => ({ ...w, persona: e.target.value }))} rows={2}
                  placeholder="Ton, Länge, Blickwinkel dieses Kanals"
                  className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 mt-1" />
              </div>
              <div className="flex items-center gap-2">
                <button onClick={submitWizard} disabled={busy === 'wizard'}
                  className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded">
                  {busy === 'wizard' ? '⏳ lege an …' : '📣 Kanal anlegen'}
                </button>
                <span className="text-[10px] text-gray-600">Erstpost-Sperre: die ersten 5 Posts brauchen immer deine Freigabe. Slots kommen als Plattform-Best-Practice, anpassbar in den Einstellungen.</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* v1014 — Bild-Bibliothek: Basis-Bilder zur Wiederverwendung (sperren/löschen) */}
      {page === 'channels' && channels.length > 0 && (
        <div className="border border-[#1f1f1f] rounded-lg p-4">
          <div className="w-full flex items-center gap-2">
            <button onClick={() => setAssetsOpen(o => !o)} className="flex-1 text-left flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-200">🖼 Bild-Bibliothek</span>
              <span className="text-[11px] text-gray-500">— Basis-Bilder, die das Studio nach Cooldown wiederverwendet{assets.length > 0 ? ` (${assets.length})` : ''}</span>
            </button>
            {/* v1026 — Overlays neu anwenden: wartende Beiträge aus Basis-Assets mit aktueller Config neu zusammensetzen */}
            <button onClick={async () => { await withBusy('refresh-overlays', async () => {
                const r = await client!.socialRefreshOverlays();
                if (!r.success) throw new Error(r.error ?? 'Refresh fehlgeschlagen');
                if (r.display) setNotice(r.display);
              }); }}
              disabled={busy === 'refresh-overlays'}
              title="Bilder aller unveröffentlichten Beiträge mit der aktuellen Overlay-Config (Titel-Stil, Logo, Ecken) neu zusammensetzen — ohne Bild-Budget"
              className="px-2 py-1 text-[11px] border border-purple-500/40 text-purple-300 hover:bg-purple-500/15 disabled:opacity-50 rounded">
              {busy === 'refresh-overlays' ? '⏳' : '🖌️ Overlays neu'}
            </button>
            {/* v1039 — Fast-Duplikate aufräumen: pro Ähnlichkeits-Gruppe bleibt ein Bild (gepinnt > meistgenutzt > neuestes) */}
            <button onClick={async () => {
                if (!confirm('Fast-Duplikate aus der Bibliothek löschen? Pro Gruppe ähnlicher Bilder bleibt eines erhalten (gepinnte immer). Datei + Eintrag der übrigen werden entfernt.')) return;
                await withBusy('dedup-library', async () => {
                  const r = await client!.socialDedupLibrary();
                  if (!r.success) throw new Error(r.error ?? 'Aufräumen fehlgeschlagen');
                  if (r.display) setNotice(r.display);
                  await loadAssets();
                });
              }}
              disabled={busy === 'dedup-library'}
              title="Fast-identische Basis-Bilder (gleicher Pool, Stil, Format, ähnliches Motiv) zusammenfassen — pro Gruppe bleibt eines, gepinnte werden nie gelöscht"
              className="px-2 py-1 text-[11px] border border-amber-500/40 text-amber-300 hover:bg-amber-500/15 disabled:opacity-50 rounded">
              {busy === 'dedup-library' ? '⏳' : '🧹 Duplikate aufräumen'}
            </button>
            {/* v1040 — Beschreibungen richtigstellen: Vision-LLM beschreibt, was die Bilder WIRKLICH zeigen */}
            <button onClick={async () => {
                if (!confirm(`Alle ${assets.length || ''} Bild-Beschreibungen per Vision-KI neu erstellen? Kostet je Bild einen günstigen Vision-Aufruf. Empfohlen VOR dem Duplikate-Aufräumen.`)) return;
                await withBusy('describe-assets', async () => {
                  const r = await client!.socialDescribeAssets();
                  if (!r.success) throw new Error(r.error ?? 'Erneuern fehlgeschlagen');
                  if (r.display) setNotice(r.display);
                  await loadAssets();
                });
              }}
              disabled={busy === 'describe-assets'}
              title="Beschreibungen stimmen oft nicht (Beschreibung = Prompt, nicht Bild): die Vision-KI schaut jedes Bild an und schreibt, was wirklich zu sehen ist — das verbessert Wiederverwendung und Duplikat-Erkennung"
              className="px-2 py-1 text-[11px] border border-sky-500/40 text-sky-300 hover:bg-sky-500/15 disabled:opacity-50 rounded">
              {busy === 'describe-assets' ? '⏳' : '🔍 Beschreibungen erneuern'}
            </button>
            <button onClick={() => setAssetsOpen(o => !o)} className="text-gray-500 text-xs">{assetsOpen ? '▲' : '▼'}</button>
          </div>
          {assetsOpen && (
            <div className="mt-3">
              {assets.length === 0 && <div className="text-xs text-gray-600">Noch keine Basis-Bilder — sie entstehen automatisch mit jedem generierten Bild.</div>}
              <div className="grid gap-2 grid-cols-2 md:grid-cols-4">
                {assets.map(a => (
                  <div key={a.id} className={clsx('border rounded-lg p-2 space-y-1', a.blocked ? 'border-red-500/30 opacity-70' : 'border-[#2a2a2a]')}>
                    {assetUrls[a.id]
                      ? <img src={assetUrls[a.id]} alt="" title="Klick = vergrößern"
                          onClick={() => {
                            // v1026 — Lightbox in voller Auflösung (Galerie zeigt nur 320px-Thumbnails)
                            setLightboxUrl(assetUrls[a.id]);
                            if (a.basename) client?.fetchSocialMediaObjectUrl(a.basename).then(full => { if (full) setLightboxUrl(full); });
                          }}
                          className="w-full h-24 object-cover rounded cursor-zoom-in" />
                      : <div className="w-full h-24 bg-[#141414] rounded" />}
                    {/* v1017 — Motiv anzeigen/bearbeiten (Matching-Schlüssel der Wiederverwendung) */}
                    {motifEditId === a.id ? (
                      <div className="space-y-1">
                        <textarea value={motifDraft} onChange={e => setMotifDraft(e.target.value)} rows={3}
                          className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-1.5 py-1 text-[10px] text-gray-200" />
                        <div className="flex items-center gap-1">
                          <button onClick={() => assetAction(a, 'motif', { motif: motifDraft })} disabled={busy === a.id}
                            className="px-1.5 py-0.5 text-[10px] bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded">✓</button>
                          <button onClick={() => setMotifEditId(null)}
                            className="px-1.5 py-0.5 text-[10px] border border-gray-500/40 text-gray-400 rounded">✕</button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-[10px] text-gray-400 line-clamp-2 cursor-text" title={`${a.motif}\n(Klick = bearbeiten)`}
                        onClick={() => { setMotifEditId(a.id); setMotifDraft(a.motif); }}>{a.motif}</div>
                    )}
                    <div className="text-[9px] text-gray-600">
                      {a.channelName ?? 'Familie'} · {a.format ?? 'square'} · {a.useCount}× · zuletzt {new Date(a.lastUsedAt).toLocaleDateString('de-AT')}
                      {a.blocked && <span className="text-red-400"> · GESPERRT</span>}
                      {a.pinned && <span className="text-emerald-400"> · 📌 STAMM</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      {/* v1038 — Stamm-Bild: bevorzugter Pool, kurze Karenz statt 30-Tage-Cooldown */}
                      <button onClick={() => assetAction(a, a.pinned ? 'unpin' : 'pin')} disabled={busy === a.id}
                        title={a.pinned ? 'Stamm-Markierung entfernen' : 'Als Stamm-Bild pinnen: bevorzugt wiederverwendet (kurze Karenz statt 30-Tage-Cooldown)'}
                        className={clsx('px-1.5 py-0.5 text-[10px] border disabled:opacity-50 rounded',
                          a.pinned ? 'border-emerald-500/60 text-emerald-300 bg-emerald-500/15' : 'border-emerald-500/30 text-emerald-400/70 hover:bg-emerald-500/15')}>
                        📌
                      </button>
                      {/* v1041 — als Termin-Vorlage für ALLE Kanäle setzen (pro Kanal: Kanal-Einstellungen → Termin-Vorlage) */}
                      <button onClick={async () => {
                          if (!confirm('Dieses Bild als Termin-Vorlage für ALLE Kanäle setzen? Termin-Posts nutzen dann immer dieses Basis-Bild (Daten kommen aus der Termin-Karte, kein Bild-Budget).')) return;
                          await withBusy(a.id, async () => {
                            for (const ch of channels) {
                              await client!.updateSocialChannel(ch.id, { config: { image_overlay: { termin_image: a.id } } });
                            }
                            if (!a.pinned) await client!.socialAssetAction(a.id, 'pin').catch(() => {});
                            setNotice(`📅 Termin-Vorlage auf ${channels.length} Kanäle gesetzt.`);
                            await loadAssets();
                            await load();
                          });
                        }} disabled={busy === a.id}
                        title="Als Termin-Vorlage für ALLE Kanäle: Termin-Ankündigungen nutzen immer dieses Bild (wird gepinnt); pro Kanal änderbar in den Kanal-Einstellungen"
                        className="px-1.5 py-0.5 text-[10px] border border-purple-500/30 text-purple-400/80 hover:bg-purple-500/15 disabled:opacity-50 rounded">
                        📅
                      </button>
                      <button onClick={() => assetAction(a, a.blocked ? 'unblock' : 'block')} disabled={busy === a.id}
                        className="px-1.5 py-0.5 text-[10px] border border-amber-500/40 text-amber-300 hover:bg-amber-500/15 disabled:opacity-50 rounded">
                        {a.blocked ? '▶ freigeben' : '⏸ sperren'}
                      </button>
                      <button onClick={() => assetAction(a, 'describe')} disabled={busy === a.id}
                        title="Motiv-Beschreibung vom Bild neu generieren lassen (Vision-KI)"
                        className="px-1.5 py-0.5 text-[10px] border border-purple-500/40 text-purple-300 hover:bg-purple-500/15 disabled:opacity-50 rounded">
                        {busy === a.id ? '⏳' : '✨ Motiv'}
                      </button>
                      <button onClick={() => assetAction(a, 'delete')} disabled={busy === a.id}
                        className="px-1.5 py-0.5 text-[10px] border border-red-500/30 text-red-400 hover:bg-red-500/15 disabled:opacity-50 rounded">🗑</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* v1000 — Verlauf (published/failed/rejected) */}
      {page === 'history' && (
        <div className="space-y-2">
          {visibleHistory.length === 0 && <div className="text-xs text-gray-600">Noch kein Verlauf.</div>}
          {visibleHistory.map(i => renderItemCard(i, i.status === 'failed'))}
        </div>
      )}

      {/* v992 — Kommentare: neu/beantwortet/ignoriert, Antwort geht LIVE */}
      {page === 'comments' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              {(['new', 'replied', 'ignored'] as const).map(s => (
                <button key={s} onClick={() => setCommentStatusFilter(s)}
                  className={clsx('px-2 py-0.5 rounded border', commentStatusFilter === s ? 'border-blue-500/50 text-blue-300 bg-blue-500/10' : 'border-[#2a2a2a] text-gray-500 hover:bg-[#1a1a1a]')}>
                  {s === 'new' ? '🆕 Neu' : s === 'replied' ? '✅ Beantwortet' : '🙈 Ignoriert'}
                </button>
              ))}
            </div>
            {comments.length === 0 && <div className="text-xs text-gray-600">Keine Kommentare in dieser Ansicht — der Collector läuft stündlich.</div>}
            {comments.map(c => {
              const channel = channels.find(ch => ch.id === c.channelId);
              return (
                <div key={c.id} className="border border-[#2a2a2a] rounded-lg p-3 space-y-1.5">
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span className="text-gray-300 font-medium">{c.author ?? 'anonym'}</span>
                    <span>auf {channel?.name ?? c.channelId.slice(0, 8)}</span>
                    {c.remoteCreatedAt && <span>· {new Date(c.remoteCreatedAt).toLocaleString('de-AT')}</span>}
                  </div>
                  <div className="text-sm text-gray-200">{c.text}</div>
                  {c.status === 'replied' && c.replyText && (
                    <div className="text-xs text-emerald-400">↪︎ Unsere Antwort: {c.replyText}</div>
                  )}
                  {c.status === 'new' && (
                    <div className="space-y-1">
                      <textarea value={replyDrafts[c.id] ?? ''} onChange={e => setReplyDrafts(d => ({ ...d, [c.id]: e.target.value }))}
                        rows={2} placeholder="Antwort schreiben — oder erst einen KI-Vorschlag holen…"
                        className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200" />
                      <div className="flex items-center gap-2 flex-wrap">
                        <button onClick={() => commentAction(c, 'suggest')} disabled={busy === c.id}
                          className="px-2 py-1 text-xs border border-purple-500/40 text-purple-300 hover:bg-purple-500/15 disabled:opacity-50 rounded">💡 KI-Vorschlag</button>
                        <button onClick={() => commentAction(c, 'reply')} disabled={busy === c.id || !(replyDrafts[c.id] ?? '').trim()}
                          className="px-2 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded">💬 Antworten (geht live)</button>
                        <button onClick={() => commentAction(c, 'ignore')} disabled={busy === c.id}
                          className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 disabled:opacity-50 rounded">Ignorieren</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

      {/* v1000 — Plan: Familien-Kalender + Wochenraster + Tagesliste */}
      {page === 'plan' && (<>
      {/* v996 — Familien-Kalender: alle Kanäle einer Familie in EINEM Raster, Story-Zugehörigkeit farbcodiert */}
      {familyCalendars.families.map(([famKey, members]) => {
        const memberIds = new Set(members.map(m => m.id));
        const famItems = calendar.filter(i => memberIds.has(i.channelId));
        if (famItems.length === 0) return null;
        const storiesInView = [...new Set(famItems.map(i => i.storyId).filter((s): s is string => !!s))];
        return (
          <div key={famKey}>
            <h2 className="text-sm font-semibold text-gray-200 mb-2">
              👪 Familien-Kalender <span className="text-gray-500 font-normal">({members.map(m => m.name).join(' · ')})</span>
            </h2>
            <div className="overflow-x-auto">
              <div className="grid gap-1 min-w-[560px]" style={{ gridTemplateColumns: `72px repeat(${members.length}, minmax(0, 1fr))` }}>
                <div />
                {members.map(m => (
                  <div key={m.id} className="text-[10px] text-gray-400 font-medium px-1 py-0.5 truncate">
                    {PLATFORM_ICON[m.platform] ?? '📣'} {m.name}
                    {m.config.family_role === 'lead' && <span className="ml-1 text-[9px] px-1 rounded bg-purple-500/20 text-purple-300 uppercase">Lead</span>}
                  </div>
                ))}
                {Array.from({ length: 14 }, (_, d) => {
                  const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + d);
                  const p = (n: number) => String(n).padStart(2, '0');
                  const key = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
                  const dayItems = famItems.filter(i => itemDayKey(i) === key);
                  if (dayItems.length === 0 && d > 6) return null; // hintere leere Tage sparen Platz
                  const isWeekend = date.getDay() === 0 || date.getDay() === 6;
                  return [
                    <div key={`${key}-label`} className={clsx('text-[9px] px-1 py-1', isWeekend ? 'text-purple-300/80' : 'text-gray-500')}>
                      {date.toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit' })}
                    </div>,
                    ...members.map(m => (
                      <div key={`${key}-${m.id}`} className={clsx('border rounded p-0.5 min-h-[26px] space-y-0.5', isWeekend ? 'border-purple-500/20 bg-purple-500/5' : 'border-[#1f1f1f]', d === 0 && 'border-blue-500/30')}>
                        {dayItems.filter(i => i.channelId === m.id).map(i => (
                          <button key={i.id} onClick={() => setDetailId(i.id)}
                            title={`${i.title ?? i.body.slice(0, 60)}${i.storyTitle ? `\nStory: ${i.storyTitle}` : ''} (${i.status})`}
                            className={clsx('block w-full text-left text-[9px] px-1 py-0.5 rounded border truncate',
                              i.storyId ? familyCalendars.storyColor.get(i.storyId) : 'border-transparent ' + (STATUS_BADGE[i.status] ?? 'bg-gray-500/20 text-gray-300'))}>
                            {(i.scheduledAt ?? i.publishedAt) ? new Date((i.scheduledAt ?? i.publishedAt)!).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }) : ''} {(i.title ?? i.body).slice(0, 18)}
                          </button>
                        ))}
                      </div>
                    )),
                  ];
                })}
              </div>
            </div>
            {storiesInView.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                <span className="text-[10px] text-gray-600">Stories:</span>
                {storiesInView.map(sid => (
                  <span key={sid} className={clsx('text-[9px] px-1.5 py-0.5 rounded border', familyCalendars.storyColor.get(sid))}>
                    {(familyCalendars.storyTitle.get(sid) ?? sid.slice(0, 8)).slice(0, 40)}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Content-Kalender */}
      <div>
        <h2 className="text-sm font-semibold text-gray-200 mb-2">🗓 Content-Kalender (14 Tage)</h2>
        {/* v966 — Wochenraster: 2×7 Tage auf einen Blick, Klick öffnet die Karte unten */}
        {calendar.length > 0 && (
          <div className="grid grid-cols-7 gap-1 mb-3">
            {Array.from({ length: 14 }, (_, d) => {
              const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + d);
              const p = (n: number) => String(n).padStart(2, '0');
              const key = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
              const items = calendarByDay.find(([day]) => day === key)?.[1] ?? [];
              const isWeekend = date.getDay() === 0 || date.getDay() === 6;
              return (
                <div key={key} className={clsx('border rounded p-1 min-h-[64px]', isWeekend ? 'border-purple-500/20 bg-purple-500/5' : 'border-[#1f1f1f]', d === 0 && 'border-blue-500/40')}>
                  <div className="text-[9px] text-gray-500 mb-0.5">
                    {date.toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit' })}
                  </div>
                  <div className="space-y-0.5">
                    {items.map(i => (
                      <button key={i.id} onClick={() => setDetailId(i.id)}
                        title={`${i.title ?? i.body.slice(0, 60)} (${channelName(i.channelId)}, ${i.status})`}
                        className={clsx('block w-full text-left text-[9px] px-1 py-0.5 rounded truncate', STATUS_BADGE[i.status] ?? 'bg-gray-500/20 text-gray-300')}>
                        {(i.scheduledAt ?? i.publishedAt) ? new Date((i.scheduledAt ?? i.publishedAt)!).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }) : ''} {PLATFORM_ICON[channels.find(c => c.id === i.channelId)?.platform ?? ''] ?? ''} {(i.title ?? i.body).slice(0, 14)}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {calendarByDay.length === 0 && <div className="text-xs text-gray-600">Nichts geplant — das Content-Studio füllt täglich um 07:30 oder per Chat: „Erzeuge Content für Kanal X".</div>}
        <div className="space-y-3">
          {calendarByDay.map(([day, items]) => (
            <div key={day}>
              <div className="text-xs text-gray-500 mb-1.5 font-medium">
                {new Date(day + 'T12:00:00').toLocaleDateString('de-AT', { weekday: 'long', day: '2-digit', month: '2-digit' })}
              </div>
              <div className="space-y-2">
                {items.map(i => renderItemCard(i, i.status !== 'published'))}
              </div>
            </div>
          ))}
        </div>
      </div>
      </>)}

      {/* v1020 — Kanalwachstum: Zeitreihen + Familien-Analyse */}
      {page === 'analytics' && Object.keys(growth).length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-200 mb-2">📈 Wachstum</h2>
          {familyGrowth.map(f => (
            <div key={f.famKey} className="border border-purple-500/20 bg-purple-500/5 rounded-lg p-3 mb-3">
              <div className="text-sm text-gray-200 font-medium">
                👪 Familien-Reichweite: {f.total.toLocaleString('de-AT')}
                <span className={clsx('ml-2 text-xs', f.delta7 > 0 ? 'text-emerald-400' : f.delta7 < 0 ? 'text-red-400' : 'text-gray-500')}>
                  {f.delta7 > 0 ? '+' : ''}{f.delta7} in 7 Tagen
                </span>
              </div>
              {f.driver && (
                <div className="text-[11px] text-gray-400 mt-1">🚀 Stärkster Treiber: {f.driver.name} (+{f.driver.delta7} · +{f.driver.pct.toFixed(1)} %)</div>
              )}
              <div className="text-[11px] text-gray-500 mt-1">
                {f.members.map(m => {
                  const share = f.total > 0 ? ((growth[m.id].latest / f.total) * 100).toFixed(0) : '0';
                  return `${m.name}: ${growth[m.id].latest.toLocaleString('de-AT')} (${share} %)`;
                }).join(' · ')}
              </div>
            </div>
          ))}
          <div className="grid gap-3 md:grid-cols-2">
            {channels.filter(c => growth[c.id]).map(c => {
              const g = growth[c.id];
              const base7 = Math.max(1, g.latest - g.delta7);
              return (
                <div key={c.id} className="border border-[#1f1f1f] rounded-lg p-3">
                  <div className="flex items-center gap-2">
                    <span>{PLATFORM_ICON[c.platform] ?? '📣'}</span>
                    <span className="text-sm text-gray-200 font-medium">{c.name}</span>
                    <div className="flex-1" />
                    <span className="text-lg text-gray-100 font-semibold">{g.latest.toLocaleString('de-AT')}</span>
                  </div>
                  <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-3">
                    <span className={clsx(g.delta7 > 0 ? 'text-emerald-400' : g.delta7 < 0 ? 'text-red-400' : '')}>
                      7 Tage: {g.delta7 > 0 ? '+' : ''}{g.delta7} ({((g.delta7 / base7) * 100).toFixed(1)} %)
                    </span>
                    <span className={clsx(g.delta30 > 0 ? 'text-emerald-400' : g.delta30 < 0 ? 'text-red-400' : '')}>
                      30 Tage: {g.delta30 > 0 ? '+' : ''}{g.delta30}
                    </span>
                    <span className="text-gray-600">seit {g.series[0].date}</span>
                  </div>
                  {g.series.length >= 2 && <div className="mt-1"><Sparkline points={g.series.map(s => s.value)} /></div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* v967 — Analytics: Verlauf je Metrik + Top-Beiträge (aus channel_metrics) */}
      {page === 'analytics' && (
        <div>
          <h2 className="text-sm font-semibold text-gray-200 mb-2">📊 Analytics</h2>
          {analytics.length === 0 && <div className="text-xs text-gray-600">Noch keine Metriken — der Analytics-Loop sammelt nach den ersten Veröffentlichungen.</div>}
          <div className="grid gap-3 md:grid-cols-2">
            {analytics.map(({ channel: c, series, topPosts }) => (
              <div key={c.id} className="border border-[#1f1f1f] rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span>{PLATFORM_ICON[c.platform] ?? '📣'}</span>
                  <span className="font-semibold text-gray-100 text-sm">{c.name}</span>
                </div>
                {series.length === 0 && <div className="text-xs text-gray-600">Noch keine Engagement-Daten — der Analytics-Collector sammelt täglich.</div>}
                <div className="space-y-1.5">
                  {series.map(s => (
                    <div key={s.kind} className="flex items-center gap-3">
                      <span className="text-[11px] text-gray-400 w-20 truncate" title={s.kind}>{s.kind}</span>
                      <Sparkline points={s.points} />
                      <span className="text-[11px] text-emerald-400">{s.total}</span>
                    </div>
                  ))}
                </div>
                {topPosts.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[11px] text-gray-500 mb-1">🏆 Top-Beiträge</div>
                    <div className="space-y-0.5">
                      {topPosts.map((p, idx) => (
                        <div key={p.id} className="text-[11px] text-gray-300 flex items-center gap-2">
                          <span className="text-gray-600">{idx + 1}.</span>
                          <span className="flex-1 truncate" title={p.title}>{p.title}</span>
                          <span className="text-emerald-400">{p.total}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* v1017 — Lightbox: Bild in groß (Klick schließt) */}
      {lightboxUrl && (
        <div className="fixed inset-0 bg-black/85 z-[60] flex items-center justify-center p-6 cursor-zoom-out" onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="" className="max-w-full max-h-full rounded-lg shadow-2xl" />
        </div>
      )}

      {/* v1001 — Detail-Sheet: großes Bild, voller Text, Story-Geschwister, alle Aktionen */}
      {detailItem && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={() => setDetailId(null)} />
          <div className="fixed inset-y-0 right-0 w-full md:w-[600px] bg-[#0d0d0d] border-l border-[#2a2a2a] z-50 overflow-y-auto p-4 space-y-3 shadow-2xl">
            <div className="flex items-center gap-2">
              <span className={clsx('px-1.5 py-0.5 rounded uppercase text-[10px]', STATUS_BADGE[detailItem.status] ?? '')}>{detailItem.status}</span>
              <span className="text-sm text-gray-400">{PLATFORM_ICON[channels.find(c => c.id === detailItem.channelId)?.platform ?? ''] ?? '📣'} {channelName(detailItem.channelId)}</span>
              <div className="flex-1" />
              <button onClick={() => setDetailId(null)} className="px-2 py-1 text-sm text-gray-400 hover:text-gray-200 border border-[#2a2a2a] rounded">✕ Schließen</button>
            </div>
            {mediaUrls[detailItem.id] && (
              <img src={mediaUrls[detailItem.id]} alt="" className="w-full rounded-lg border border-[#2a2a2a] object-cover max-h-[340px]" />
            )}
            <div className="text-base font-semibold text-gray-100">{detailItem.title ?? '(ohne Titel)'}</div>
            {/* voller Text, wie er gepostet wird (Hashtags + ggf. KI-Kennzeichnung kommen beim Publish dazu) */}
            <div className="text-sm text-gray-300 whitespace-pre-wrap break-words">{detailItem.body}</div>
            {detailItem.hashtags.length > 0 && (
              <div className="text-xs text-blue-400">{detailItem.hashtags.map(h => `#${h.replace(/^#/, '')}`).join(' ')}</div>
            )}
            {detailItem.media?.some(m => m.source === 'generated') && (
              <div className="text-[11px] text-gray-500">🎨 Bild KI-generiert — Kennzeichnung wird beim Posten automatisch angehängt.</div>
            )}
            {/* v1001 — Story-Kontext: Geschwister-Beiträge derselben Story */}
            {detailItem.storyId && (
              <div className="border border-purple-500/20 bg-purple-500/5 rounded-lg p-2.5 space-y-1.5">
                <div className="text-[11px] font-medium text-purple-300">📖 Story{detailStoryTitle ? `: ${detailStoryTitle}` : ''}</div>
                {detailSiblings.length === 0 && <div className="text-[11px] text-gray-500">Keine Geschwister-Beiträge geladen.</div>}
                {detailSiblings.map(s => (
                  <button key={s.id} onClick={() => setDetailId(s.id)}
                    className="w-full text-left text-[11px] text-gray-300 hover:bg-[#1a1a1a] rounded px-1.5 py-1 flex items-center gap-2">
                    <span className={clsx('px-1 py-0.5 rounded uppercase text-[9px]', STATUS_BADGE[s.status] ?? '')}>{s.status}</span>
                    <span className="text-gray-500">{channelName(s.channelId)}</span>
                    <span className="flex-1 truncate">{s.title ?? s.body.slice(0, 50)}</span>
                    {(s.scheduledAt ?? s.publishedAt) && <span className="text-gray-600">{fmtDateTime((s.scheduledAt ?? s.publishedAt)!)}</span>}
                  </button>
                ))}
              </div>
            )}
            {/* alle Aktionen über die bekannte Karte (Bearbeiten, Verbessern, Umterminieren, Crosspost …) */}
            {renderItemCard(detailItem, true)}
          </div>
        </>
      )}
    </div>
  );
}
