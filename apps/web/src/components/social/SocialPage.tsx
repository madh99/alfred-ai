'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import type { SocialChannelItem, SocialContentItem } from '@/lib/alfred-client';

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

type QueueTab = 'pending' | 'history';

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
  // v964 — Queue-Tabs + Kanal-Filter
  const [tab, setTab] = useState<QueueTab>('pending');
  const [channelFilter, setChannelFilter] = useState<string>('');
  // v964 — Umterminieren (Inline-Datepicker je Item)
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [rescheduleAt, setRescheduleAt] = useState<string>('');
  // v948 — Bild-Vorschauen: Blob-URLs je Item (Auth via Bearer, daher kein direktes <img src>)
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  // v955 — Inline-Editor (Korrektur + optionale Lektion, aus der der Kanal lernt)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ title: string; body: string; hashtags: string; lesson: string }>({ title: '', body: '', hashtags: '', lesson: '' });

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const [ch, sched, drafts, approved, published, cal] = await Promise.all([
        client.fetchSocialChannels(),
        client.fetchSocialItems({ status: 'scheduled', limit: 50 }),
        client.fetchSocialItems({ status: 'draft', limit: 50 }),
        client.fetchSocialItems({ status: 'approved', limit: 50 }),
        client.fetchSocialItems({ status: 'published', limit: 100 }),
        client.fetchSocialCalendar(new Date().toISOString(), new Date(Date.now() + 14 * 24 * 3_600_000).toISOString()),
      ]);
      setChannels(ch);
      // v964 — auch approved gehört in die Queue (vorher unsichtbar, bis es im Kalender auftauchte)
      const byTime = (a: SocialContentItem, b: SocialContentItem) => (a.scheduledAt ?? '9999').localeCompare(b.scheduledAt ?? '9999');
      setPending([...approved, ...sched, ...drafts].sort(byTime));
      setPublishedRecent(published);
      setCalendar(cal);
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

  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab, loadHistory]);

  // v948 — Bild-Vorschauen nachladen (erstes image je Item)
  useEffect(() => {
    if (!client) return;
    const items = [...pending, ...calendar, ...history];
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

  async function itemAction(item: SocialContentItem, action: 'approve' | 'reject' | 'publish' | 'delete') {
    if (action === 'delete' && !confirm('Beitrag auf der Plattform UND in Alfred löschen?')) return;
    await withBusy(item.id, async () => {
      const r = await client!.socialItemAction(item.id, action);
      if (!r.success) throw new Error(r.error ?? 'Aktion fehlgeschlagen');
      if (r.display) setNotice(r.display);
      await load();
      if (tab === 'history') await loadHistory();
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
  const visiblePending = useMemo(() => filterByChannel(pending), [pending, filterByChannel]);
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

  function renderItemCard(item: SocialContentItem, showActions: boolean) {
    const isOpen = expandedItem === item.id;
    const previewUrl = mediaUrls[item.id];
    const hasVideo = item.media?.some(m => m.type === 'video');
    const hint = blockedHint(item);
    return (
      <div key={item.id} className="border border-[#1f1f1f] rounded-lg p-3">
        <div className="flex items-center gap-2 flex-wrap text-xs">
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
              <button onClick={() => itemAction(item, 'reject')} disabled={busy === item.id}
                className="px-2 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/15 rounded">✕ Ablehnen</button>
            </>
          )}
          {/* v964 — published: auf der Plattform löschen (delete_remote-Leitplanke) */}
          {item.status === 'published' && (
            <button onClick={() => itemAction(item, 'delete')} disabled={busy === item.id}
              className="px-2 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/15 rounded">🗑 Löschen</button>
          )}
        </div>
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
        <button onClick={pauseAll} disabled={busy === 'pause-all'}
          className="px-3 py-1.5 text-sm border border-red-500/40 text-red-400 hover:bg-red-500/15 disabled:opacity-50 rounded"
          title="Not-Aus: pausiert sofort alle Kanäle">🛑 Social-Stopp</button>
      </div>

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

      {/* Kanäle */}
      {channels.length > 0 && (
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
                <span className={clsx((publishedTodayByChannel[c.id] ?? 0) >= c.maxPostsPerDay && 'text-amber-400')}>
                  Heute {publishedTodayByChannel[c.id] ?? 0}/{c.maxPostsPerDay}
                </span>
                <span>· Horizont {c.planningHorizonDays}d</span>
                <span>· Erstpost-Streak {Math.min(c.approvedStreak, 5)}/5{c.approvedStreak >= 5 ? ' ✓' : ''}</span>
              </div>
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
                <button onClick={() => toggleChannelStatus(c)} disabled={busy === c.id}
                  className={clsx('px-2 py-1 text-xs rounded border',
                    c.status === 'active' ? 'border-gray-500/40 text-gray-400 hover:bg-gray-500/15' : 'border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15')}>
                  {c.status === 'active' ? '⏸ Pausieren' : '▶ Aktivieren'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* v964 — Queue mit Tabs (Wartend/Verlauf) + Kanal-Filter */}
      <div>
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <button onClick={() => setTab('pending')}
            className={clsx('px-2.5 py-1 text-xs rounded border', tab === 'pending' ? 'border-blue-500/50 text-blue-300 bg-blue-500/10' : 'border-[#2a2a2a] text-gray-400 hover:bg-[#1a1a1a]')}>
            📤 Wartet auf dich ({visiblePending.length})
          </button>
          <button onClick={() => setTab('history')}
            className={clsx('px-2.5 py-1 text-xs rounded border', tab === 'history' ? 'border-blue-500/50 text-blue-300 bg-blue-500/10' : 'border-[#2a2a2a] text-gray-400 hover:bg-[#1a1a1a]')}>
            🗂 Verlauf
          </button>
          <div className="flex-1" />
          {channels.length > 1 && (
            <select value={channelFilter} onChange={e => setChannelFilter(e.target.value)}
              className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
              <option value="">Alle Kanäle</option>
              {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
        {tab === 'pending' && (
          <div className="space-y-2">
            {visiblePending.length === 0 && <div className="text-xs text-gray-600">Nichts offen — alles freigegeben oder noch nichts erzeugt.</div>}
            {visiblePending.map(i => renderItemCard(i, true))}
          </div>
        )}
        {tab === 'history' && (
          <div className="space-y-2">
            {visibleHistory.length === 0 && <div className="text-xs text-gray-600">Noch kein Verlauf.</div>}
            {visibleHistory.map(i => renderItemCard(i, i.status === 'failed'))}
          </div>
        )}
      </div>

      {/* Content-Kalender */}
      <div>
        <h2 className="text-sm font-semibold text-gray-200 mb-2">🗓 Content-Kalender (14 Tage)</h2>
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
    </div>
  );
}
