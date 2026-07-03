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

export function SocialPage() {
  const { client } = useConfig();
  const [channels, setChannels] = useState<SocialChannelItem[]>([]);
  const [pending, setPending] = useState<SocialContentItem[]>([]);
  const [calendar, setCalendar] = useState<SocialContentItem[]>([]);
  const [metrics, setMetrics] = useState<Record<string, Array<{ kind: string; value: number; date: string; itemId?: string }>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedItem, setExpandedItem] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const [ch, sched, drafts, cal] = await Promise.all([
        client.fetchSocialChannels(),
        client.fetchSocialItems({ status: 'scheduled', limit: 50 }),
        client.fetchSocialItems({ status: 'draft', limit: 50 }),
        client.fetchSocialCalendar(new Date().toISOString(), new Date(Date.now() + 14 * 24 * 3_600_000).toISOString()),
      ]);
      setChannels(ch);
      setPending([...sched, ...drafts]);
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

  const channelName = useCallback((id: string) => channels.find(c => c.id === id)?.name ?? id.slice(0, 8), [channels]);

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

  async function itemAction(item: SocialContentItem, action: 'approve' | 'reject' | 'publish') {
    await withBusy(item.id, async () => {
      const r = await client!.socialItemAction(item.id, action);
      if (!r.success) throw new Error(r.error ?? 'Aktion fehlgeschlagen');
      await load();
    });
  }

  /** Kalender nach Tag gruppiert (kommende 14 Tage). */
  const calendarByDay = useMemo(() => {
    const map = new Map<string, SocialContentItem[]>();
    for (const item of calendar) {
      const day = (item.scheduledAt ?? item.publishedAt ?? '').slice(0, 10);
      if (!day) continue;
      map.set(day, [...(map.get(day) ?? []), item]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [calendar]);

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
    return (
      <div key={item.id} className="border border-[#1f1f1f] rounded-lg p-3">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className={clsx('px-1.5 py-0.5 rounded uppercase text-[10px]', STATUS_BADGE[item.status] ?? '')}>{item.status}</span>
          <span className="text-gray-400">{channelName(item.channelId)}</span>
          {item.scheduledAt && <span className="text-gray-500">⏰ {item.scheduledAt.slice(0, 16).replace('T', ' ')}</span>}
          {item.source === 'studio' && <span className="text-purple-400 text-[10px]">Studio</span>}
          {item.error && <span className="text-red-400 truncate max-w-[200px]" title={item.error}>⚠ {item.error.slice(0, 40)}</span>}
          <div className="flex-1" />
          <span className="font-mono text-gray-600">{item.id.slice(0, 8)}</span>
        </div>
        <div className="mt-1.5 text-sm text-gray-200 font-medium">{item.title ?? item.body.slice(0, 80)}</div>
        <div className={clsx('text-xs text-gray-400 whitespace-pre-wrap break-words mt-1', !isOpen && 'line-clamp-2')}>
          {item.body}
          {item.hashtags.length > 0 && <div className="text-blue-400 mt-1">{item.hashtags.map(h => `#${h.replace(/^#/, '')}`).join(' ')}</div>}
        </div>
        {item.body.length > 150 && (
          <button onClick={() => setExpandedItem(isOpen ? null : item.id)} className="text-[11px] text-blue-400 hover:text-blue-300 mt-1">
            {isOpen ? '▲ einklappen' : '▼ ganzen Text zeigen'}
          </button>
        )}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {item.externalUrl && (
            <a href={item.externalUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:text-blue-300">🔗 Post öffnen</a>
          )}
          {showActions && (item.status === 'draft' || item.status === 'scheduled' || item.status === 'failed') && (
            <>
              {item.status !== 'failed' && (
                <button onClick={() => itemAction(item, 'approve')} disabled={busy === item.id}
                  className="px-2 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded">✅ Freigeben</button>
              )}
              <button onClick={() => itemAction(item, 'publish')} disabled={busy === item.id}
                className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded">🚀 Sofort posten</button>
              <button onClick={() => itemAction(item, 'reject')} disabled={busy === item.id}
                className="px-2 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/15 rounded">✕ Ablehnen</button>
            </>
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
                <span>Limit {c.maxPostsPerDay}/Tag</span>
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

      {/* Freigabe-Queue */}
      {pending.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-200 mb-2">📤 Wartet auf dich ({pending.length})</h2>
          <div className="space-y-2">
            {pending.map(i => renderItemCard(i, true))}
          </div>
        </div>
      )}

      {/* Content-Kalender */}
      <div>
        <h2 className="text-sm font-semibold text-gray-200 mb-2">🗓 Content-Kalender (14 Tage)</h2>
        {calendarByDay.length === 0 && <div className="text-xs text-gray-600">Nichts geplant — das Content-Studio füllt täglich um 07:30 oder per Chat: „Erzeuge Content für Kanal X".</div>}
        <div className="space-y-3">
          {calendarByDay.map(([day, items]) => (
            <div key={day}>
              <div className="text-xs text-gray-500 mb-1.5 font-medium">
                {new Date(day + 'T12:00:00Z').toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' })}
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
