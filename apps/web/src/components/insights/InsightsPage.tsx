'use client';

import { useEffect, useState, useCallback } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import type { InsightItem } from '@/lib/alfred-client';

const CATEGORY_ICONS: Record<string, string> = {
  'infra-forecast': '📈',
  'calendar-mismatch': '📅',
  'kg-gap': '🧠',
  'cross-source-mention': '🔗',
  'open-loop': '💬',
  'goal-drift': '🎯',
  'skill-workflow': '⚙️',
  'finance': '💰',
  'meta': '🤖',
};

const CATEGORY_LABEL: Record<string, string> = {
  'infra-forecast': 'Infrastruktur',
  'calendar-mismatch': 'Kalender',
  'kg-gap': 'Knowledge-Graph',
  'cross-source-mention': 'Quervergleich',
  'open-loop': 'Offene Themen',
  'goal-drift': 'Ziele',
  'skill-workflow': 'Workflows',
  'finance': 'Finanzen',
  'meta': 'Alfred-Meta',
};

export function InsightsPage() {
  const { client } = useConfig();
  const [insights, setInsights] = useState<InsightItem[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [filterCat, setFilterCat] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('pending');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const [list, s] = await Promise.all([
        client.fetchInsights({
          category: filterCat === 'all' ? undefined : filterCat,
          status: filterStatus,
          limit: 200,
        }),
        client.fetchInsightsStats().catch(() => ({})),
      ]);
      setInsights(list);
      setStats(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [client, filterCat, filterStatus]);

  useEffect(() => { load(); }, [load]);

  async function runSweep() {
    if (!client) return;
    setSweeping(true); setError(null);
    try {
      const r = await client.runInsightsSweep();
      alert(`Sweep abgeschlossen: ${r.inserted} neu, ${r.refreshed} aktualisiert.${r.errors.length ? '\n\nFehler:\n' + r.errors.join('\n') : ''}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSweeping(false); }
  }

  async function handleDismiss(id: string) {
    if (!client) return;
    setBusy(id);
    try { await client.dismissInsight(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function handleSnooze(id: string, hours: number) {
    if (!client) return;
    setBusy(id);
    try { await client.snoozeInsight(id, hours); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function handleAct(id: string, hasAction: boolean) {
    if (!client) return;
    if (!hasAction) { alert('Dieses Insight hat keine gebundene Aktion.'); return; }
    if (!confirm('Aktion ausführen?')) return;
    setBusy(id);
    try {
      const r = await client.actOnInsight(id);
      if (r.ok) {
        alert('Aktion ausgeführt.');
        await load();
      } else {
        alert(`Fehler: ${r.reason}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  function toggleExpand(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const categories = ['all', ...Object.keys(CATEGORY_LABEL)];
  const statuses = ['pending', 'snoozed', 'acted', 'dismissed', 'expired'];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">💡 Insights</h1>
          <p className="text-sm text-gray-500">Cross-Domain-Vorschläge — kombiniert aus Calendar, KG, ITSM, Chats &amp; Infra-Daten.</p>
        </div>
        <button
          onClick={runSweep}
          disabled={sweeping}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
        >{sweeping ? 'Sweep läuft …' : '🔄 Sweep jetzt'}</button>
      </div>

      {/* Stats row */}
      {Object.keys(stats).length > 0 && (
        <div className="flex gap-3 text-xs">
          {(['pending', 'snoozed', 'acted', 'dismissed', 'expired'] as const).map(k => (
            <div key={k} className="bg-[#111] border border-[#1f1f1f] rounded px-3 py-2">
              <div className="text-gray-500 uppercase">{k}</div>
              <div className="text-gray-200 font-mono text-base">{stats[k] ?? 0}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <select
          value={filterCat}
          onChange={(e) => setFilterCat(e.target.value)}
          className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200"
        >
          {categories.map(c => (
            <option key={c} value={c}>{c === 'all' ? 'Alle Kategorien' : `${CATEGORY_ICONS[c] ?? '·'} ${CATEGORY_LABEL[c] ?? c}`}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200"
        >
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="flex-1" />
        <button onClick={load} className="px-3 py-1.5 text-sm text-blue-400 hover:text-blue-300">↻ Neu laden</button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-sm text-red-400">{error}</div>
      )}

      {loading && <div className="text-gray-500 text-sm">Lade …</div>}

      {!loading && insights.length === 0 && (
        <div className="border border-dashed border-[#2a2a2a] rounded-lg p-12 text-center text-gray-500">
          <div className="text-4xl mb-2">🎉</div>
          <div className="text-sm">Keine offenen Insights — alles im Griff!</div>
          <div className="text-xs mt-2 text-gray-600">Sweep läuft täglich um 09:00 lokal, oder per Button.</div>
        </div>
      )}

      <div className="space-y-3">
        {insights.map(i => {
          const conf = Math.round(i.confidence * 100);
          const flag = i.confidence >= 0.8 ? 'text-red-400 border-red-500/40 bg-red-500/5'
            : i.confidence >= 0.6 ? 'text-amber-400 border-amber-500/40 bg-amber-500/5'
            : 'text-emerald-400 border-emerald-500/40 bg-emerald-500/5';
          const isExpanded = expandedIds.has(i.id);
          return (
            <div key={i.id} className={clsx('border rounded-lg p-4', flag)}>
              <div className="flex items-start gap-3">
                <div className="text-2xl">{CATEGORY_ICONS[i.category] ?? '💡'}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                    <span className="font-semibold">{CATEGORY_LABEL[i.category] ?? i.category}</span>
                    <span>·</span>
                    <span>Confidence {conf}%</span>
                    {i.status === 'snoozed' && i.snoozedUntil && (
                      <><span>·</span><span>snoozed bis {i.snoozedUntil.slice(0, 16)}</span></>
                    )}
                    <span>·</span>
                    <span className="font-mono normal-case">{i.id.slice(0, 8)}</span>
                  </div>
                  <h3 className="text-base font-semibold text-gray-100 mb-2">{i.title}</h3>
                  <div className={clsx('text-sm text-gray-300 whitespace-pre-wrap break-words', !isExpanded && 'line-clamp-3')}>
                    {i.body}
                  </div>
                  {i.body.length > 200 && (
                    <button
                      onClick={() => toggleExpand(i.id)}
                      className="text-xs text-blue-400 hover:text-blue-300 mt-1"
                    >{isExpanded ? '▲ einklappen' : '▼ mehr anzeigen'}</button>
                  )}
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    {i.actionSkill && i.status === 'pending' && (
                      <button
                        onClick={() => handleAct(i.id, true)}
                        disabled={busy === i.id}
                        className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
                      >▶ {i.actionSkill}</button>
                    )}
                    {i.status === 'pending' && (
                      <>
                        <button
                          onClick={() => handleSnooze(i.id, 24)}
                          disabled={busy === i.id}
                          className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded"
                        >💤 24h</button>
                        <button
                          onClick={() => handleSnooze(i.id, 168)}
                          disabled={busy === i.id}
                          className="px-2 py-1 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-500/15 rounded"
                        >💤 7d</button>
                      </>
                    )}
                    {(i.status === 'pending' || i.status === 'snoozed') && (
                      <button
                        onClick={() => handleDismiss(i.id)}
                        disabled={busy === i.id}
                        className="px-2 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/15 rounded"
                      >✕ Erledigt</button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
