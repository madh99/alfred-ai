'use client';

import { useEffect, useState, useCallback } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import type { InterestTopicItem, InterestItemEntry, NotificationSettings, InsightItem } from '@/lib/alfred-client';

const URGENCIES = ['low', 'normal', 'high', 'urgent'] as const;
const URGENCY_LABEL: Record<string, string> = {
  low: 'Alles melden (low+)',
  normal: 'Ab normal',
  high: 'Nur Wichtiges (high+)',
  urgent: 'Nur Dringendes',
};

export function InterestsPage() {
  const { client } = useConfig();
  const [topics, setTopics] = useState<InterestTopicItem[]>([]);
  const [suggestions, setSuggestions] = useState<InsightItem[]>([]);
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, InterestItemEntry[]>>({});
  // Neues-Thema-Formular
  const [newName, setNewName] = useState('');
  const [newKeywords, setNewKeywords] = useState('');
  // Quelle-hinzufügen-Formular je Topic
  const [srcKind, setSrcKind] = useState<'rss' | 'web_search' | 'youtube'>('rss');
  const [srcValue, setSrcValue] = useState('');

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const [t, s, sug] = await Promise.all([
        client.fetchInterestTopics(),
        client.fetchNotificationSettings().catch(() => null),
        client.fetchInsights({ category: 'interest-suggestion', status: 'pending', limit: 20 }).catch(() => []),
      ]);
      setTopics(t);
      setSettings(s);
      setSuggestions(sug.filter(i => i.actionSkill === 'interests'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function createTopic() {
    if (!client || !newName.trim()) return;
    await withBusy('create', async () => {
      const keywords = newKeywords.split(',').map(k => k.trim()).filter(Boolean);
      await client.createInterestTopic(newName.trim(), keywords.length ? keywords : undefined);
      setNewName(''); setNewKeywords('');
      await load();
    });
  }

  async function toggleExpand(topic: InterestTopicItem) {
    if (expanded === topic.id) { setExpanded(null); return; }
    setExpanded(topic.id);
    setSrcValue(''); setSrcKind('rss');
    if (client && !items[topic.id]) {
      try {
        const list = await client.fetchInterestItems(topic.id, 30);
        setItems(prev => ({ ...prev, [topic.id]: list }));
      } catch { /* Timeline optional */ }
    }
  }

  async function setStatus(topic: InterestTopicItem, status: 'active' | 'paused' | 'archived') {
    if (!client) return;
    await withBusy(topic.id, async () => { await client.updateInterestTopic(topic.id, { status }); await load(); });
  }

  async function setThreshold(topic: InterestTopicItem, notifyThreshold: string) {
    if (!client) return;
    await withBusy(topic.id, async () => { await client.updateInterestTopic(topic.id, { notifyThreshold }); await load(); });
  }

  async function addSource(topic: InterestTopicItem) {
    if (!client || !srcValue.trim()) return;
    await withBusy(`src-${topic.id}`, async () => {
      await client.addInterestSource(topic.id, srcKind === 'rss'
        ? { kind: 'rss', url: srcValue.trim() }
        : srcKind === 'youtube'
          ? { kind: 'youtube', channel: srcValue.trim() }
          : { kind: 'web_search', query: srcValue.trim() });
      setSrcValue('');
      await load();
    });
  }

  async function removeSource(topic: InterestTopicItem, sourceId: string) {
    if (!client) return;
    await withBusy(`src-${topic.id}`, async () => { await client.removeInterestSource(topic.id, sourceId); await load(); });
  }

  async function collectNow(topic?: InterestTopicItem) {
    if (!client) return;
    await withBusy(topic ? `collect-${topic.id}` : 'collect', async () => {
      const n = await client.collectInterestsNow(topic?.id);
      alert(`Sammellauf fertig: ${n} neue Beiträge.`);
      setItems({});
      await load();
    });
  }

  // Vorgeschlagene Themen (Interest-Detector) bestätigen / ablehnen
  async function confirmSuggestion(s: InsightItem) {
    if (!client) return;
    await withBusy(s.id, async () => {
      const r = await client.actOnInsight(s.id);
      if (!r.ok) throw new Error(r.reason ?? 'Aktion fehlgeschlagen');
      await load();
    });
  }
  async function rejectSuggestion(s: InsightItem) {
    if (!client) return;
    await withBusy(s.id, async () => { await client.dismissInsight(s.id); await load(); });
  }

  async function saveSettings(patch: Partial<NotificationSettings>) {
    if (!client) return;
    await withBusy('settings', async () => {
      const updated = await client.updateNotificationSettings(patch);
      setSettings(updated);
    });
  }

  const active = topics.filter(t => t.status !== 'archived');
  const archived = topics.filter(t => t.status === 'archived');

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">📡 Interessen</h1>
          <p className="text-sm text-gray-500">Themen, die Alfred laufend beobachtet — stündlich gesammelt (RSS + Web-Suche), abrufbar per „Was gibt&apos;s Neues zu …?"</p>
        </div>
        <button
          onClick={() => collectNow()}
          disabled={busy === 'collect'}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
        >{busy === 'collect' ? 'Sammle …' : '🔄 Jetzt sammeln'}</button>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-sm text-red-400">{error}</div>}
      {loading && <div className="text-gray-500 text-sm">Lade …</div>}

      {/* Vorgeschlagene Themen (Interest-Detector) */}
      {suggestions.length > 0 && (
        <div className="border border-purple-500/30 bg-purple-500/5 rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-semibold text-purple-300">💡 Vorgeschlagene Themen ({suggestions.length})</h2>
          {suggestions.map(s => (
            <div key={s.id} className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-200 font-medium">{s.title.replace('Interesse erkannt: ', '')}</div>
                <div className="text-xs text-gray-400 line-clamp-2">{s.body}</div>
              </div>
              <button onClick={() => confirmSuggestion(s)} disabled={busy === s.id}
                className="px-2 py-1 text-xs bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded shrink-0">✓ Beobachten</button>
              <button onClick={() => rejectSuggestion(s)} disabled={busy === s.id}
                className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded shrink-0">✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Neues Thema */}
      <div className="border border-[#1f1f1f] rounded-lg p-4 flex gap-2 flex-wrap items-end">
        <label className="text-xs text-gray-400">
          Neues Thema
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="z.B. Claude Fable"
            className="mt-1 block w-56 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200" />
        </label>
        <label className="text-xs text-gray-400">
          Stichwörter (kommagetrennt, optional)
          <input value={newKeywords} onChange={e => setNewKeywords(e.target.value)} placeholder="claude, fable, anthropic"
            className="mt-1 block w-72 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200" />
        </label>
        <button onClick={createTopic} disabled={busy === 'create' || !newName.trim()}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
        >{busy === 'create' ? 'Lege an …' : '+ Beobachten'}</button>
        <span className="text-[10px] text-gray-600">Quellen (RSS + Suche) werden automatisch bestückt.</span>
      </div>

      {!loading && active.length === 0 && (
        <div className="border border-dashed border-[#2a2a2a] rounded-lg p-10 text-center text-gray-500 text-sm">
          Noch keine Themen — oben anlegen, oder Alfred im Chat sagen: „Beobachte das Thema X für mich."
        </div>
      )}

      {/* Topic-Karten */}
      <div className="space-y-3">
        {active.map(t => {
          const isOpen = expanded === t.id;
          return (
            <div key={t.id} className={clsx('border rounded-lg', t.status === 'paused' ? 'border-gray-500/30 opacity-70' : 'border-[#1f1f1f]')}>
              <div className="p-4 cursor-pointer" onClick={() => toggleExpand(t)}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-lg">📡</span>
                  <span className="text-base font-semibold text-gray-100">{t.name}</span>
                  {t.origin === 'auto' && <span className="text-[10px] px-1.5 py-0.5 bg-purple-500/20 text-purple-300 rounded uppercase">auto erkannt</span>}
                  {t.status === 'paused' && <span className="text-[10px] px-1.5 py-0.5 bg-gray-500/20 text-gray-400 rounded uppercase">pausiert</span>}
                  <span className="text-xs text-gray-500">{t.sources.length} Quelle(n) · {t.itemsLast7d} Beiträge/7d</span>
                  <div className="flex-1" />
                  <span className="text-gray-500 text-sm">{isOpen ? '▾' : '▸'}</span>
                </div>
                {t.digest?.summary && (
                  <p className={clsx('text-sm text-gray-400 mt-2 whitespace-pre-wrap', !isOpen && 'line-clamp-2')}>{t.digest.summary}</p>
                )}
              </div>
              {isOpen && (
                <div className="border-t border-[#1f1f1f] p-4 space-y-4">
                  {/* Aktionen + Schwelle */}
                  <div className="flex gap-2 flex-wrap items-center">
                    <button onClick={() => collectNow(t)} disabled={busy === `collect-${t.id}`}
                      className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded">🔄 Jetzt sammeln</button>
                    {t.status === 'active'
                      ? <button onClick={() => setStatus(t, 'paused')} className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded">⏸ Pausieren</button>
                      : <button onClick={() => setStatus(t, 'active')} className="px-2 py-1 text-xs border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15 rounded">▶ Aktivieren</button>}
                    <button onClick={() => { if (confirm(`Thema "${t.name}" archivieren?`)) setStatus(t, 'archived'); }}
                      className="px-2 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/15 rounded">🗄 Archivieren</button>
                    <div className="flex-1" />
                    <label className="text-xs text-gray-500 flex items-center gap-2">
                      Aktiv melden:
                      <select value={t.notifyThreshold} onChange={e => setThreshold(t, e.target.value)}
                        className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
                        {URGENCIES.map(u => <option key={u} value={u}>{URGENCY_LABEL[u]}</option>)}
                      </select>
                    </label>
                  </div>

                  {/* Quellen */}
                  <div>
                    <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Quellen</h3>
                    {t.sources.length === 0 && <div className="text-xs text-gray-600">Keine Quellen — unten hinzufügen.</div>}
                    <div className="space-y-1">
                      {t.sources.map(s => (
                        <div key={s.id} className="flex items-center gap-2 text-sm">
                          <span className="text-[10px] px-1.5 py-0.5 bg-[#1a1a1a] text-gray-400 rounded uppercase shrink-0">{s.kind}</span>
                          <span className="text-gray-300 truncate flex-1">{s.kind === 'rss' ? s.config.url : s.kind === 'youtube' ? `Kanal: ${s.config.channel ?? s.config.channel_id_cached ?? '?'}` : `Suche: ${s.config.query}`}</span>
                          {s.addedBy === 'auto' && <span className="text-[10px] text-purple-400 shrink-0">auto</span>}
                          <button onClick={() => removeSource(t, s.id)} disabled={busy === `src-${t.id}`}
                            className="text-xs text-red-400 hover:text-red-300 shrink-0">✕</button>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2 mt-2 items-center">
                      <select value={srcKind} onChange={e => setSrcKind(e.target.value as 'rss' | 'web_search' | 'youtube')}
                        className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200">
                        <option value="rss">RSS</option>
                        <option value="web_search">Web-Suche</option>
                        <option value="youtube">YouTube-Kanal</option>
                      </select>
                      <input value={srcValue} onChange={e => setSrcValue(e.target.value)}
                        placeholder={srcKind === 'rss' ? 'https://…/feed.xml' : srcKind === 'youtube' ? '@handle, Kanal-URL oder Kanalname' : 'Suchanfrage'}
                        className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200" />
                      <button onClick={() => addSource(t)} disabled={busy === `src-${t.id}` || !srcValue.trim()}
                        className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded">+ Quelle</button>
                    </div>
                  </div>

                  {/* Item-Timeline */}
                  <div>
                    <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Neueste Beiträge</h3>
                    {(items[t.id] ?? []).length === 0 && <div className="text-xs text-gray-600">Noch keine Beiträge gesammelt.</div>}
                    <div className="space-y-1.5">
                      {(items[t.id] ?? []).map(i => (
                        <div key={i.id} className="text-sm">
                          {i.url
                            ? <a href={i.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">{i.title}</a>
                            : <span className="text-gray-300">{i.title}</span>}
                          <span className="text-[10px] text-gray-600 ml-2">
                            {(i.publishedAt ?? i.createdAt).slice(0, 10)} · {i.sourceKind}
                            {typeof i.importance === 'number' && ` · Relevanz ${(i.importance * 100).toFixed(0)}%`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {archived.length > 0 && (
        <details className="text-sm text-gray-500">
          <summary className="cursor-pointer">🗄 Archivierte Themen ({archived.length})</summary>
          <div className="mt-2 space-y-1">
            {archived.map(t => (
              <div key={t.id} className="flex items-center gap-2">
                <span className="text-gray-400">{t.name}</span>
                <button onClick={() => setStatus(t, 'active')} className="text-xs text-emerald-400 hover:text-emerald-300">wieder aktivieren</button>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Router-Einstellungen (Stiller Modus) */}
      {settings && (
        <div className="border border-[#1f1f1f] rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-200">🔔 Benachrichtigungs-Einstellungen (Stiller Modus)</h2>
          <p className="text-xs text-gray-500">
            Proaktive Meldungen unterhalb der Schwelle werden nicht gesendet, sondern still in den Insights abgelegt — nichts geht verloren.
            Änderungen wirken sofort und überleben Neustarts.
          </p>
          <div className="flex gap-4 flex-wrap items-center">
            <label className="text-xs text-gray-400 flex items-center gap-2">
              Sende-Schwelle:
              <select
                value={settings.minUrgency}
                onChange={e => saveSettings({ minUrgency: e.target.value as NotificationSettings['minUrgency'] })}
                disabled={busy === 'settings'}
                className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200"
              >
                {URGENCIES.map(u => <option key={u} value={u}>{URGENCY_LABEL[u]}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-400 flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={settings.devMode}
                onChange={e => saveSettings({ devMode: e.target.checked })}
                disabled={busy === 'settings'} />
              Dev-Mode (alles senden wie früher)
            </label>
          </div>
          {Object.keys(settings.perSource ?? {}).length > 0 && (
            <div className="text-xs text-gray-500">
              Sender-Overrides: {Object.entries(settings.perSource).map(([k, v]) => `${k}→${v}`).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
