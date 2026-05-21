'use client';

import { useEffect, useState, useCallback } from 'react';
import clsx from 'clsx';
import { useConfig } from '@/context/ConfigContext';
import type { GoalItem, GoalCheckpointItem } from '@/lib/alfred-client';

const STATUS_COLOR: Record<string, string> = {
  active: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
  paused: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
  achieved: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
  abandoned: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/40',
};
const CHECK_COLOR: Record<string, string> = {
  'on-track': 'text-emerald-400',
  'drifting': 'text-amber-400',
  'achieved': 'text-emerald-500',
  'no-data': 'text-gray-500',
};

export function GoalsPage() {
  const { client } = useConfig();
  const [goals, setGoals] = useState<GoalItem[]>([]);
  const [selected, setSelected] = useState<GoalItem | null>(null);
  const [checkpoints, setCheckpoints] = useState<GoalCheckpointItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('active');
  const [showAdd, setShowAdd] = useState(false);
  const [newGoal, setNewGoal] = useState<Partial<GoalItem>>({});
  const [checking, setChecking] = useState<{ id: string; status: string; notes: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const list = await client.fetchGoals(filterStatus === 'all' ? {} : { status: filterStatus });
      setGoals(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [client, filterStatus]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected || !client) { setCheckpoints([]); return; }
    client.fetchGoalDetail(selected.id).then(d => setCheckpoints(d?.checkpoints ?? []));
  }, [selected, client]);

  async function handleAdd() {
    if (!client || !newGoal.title?.trim()) return;
    try {
      await client.addGoal(newGoal);
      setShowAdd(false);
      setNewGoal({});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCheck() {
    if (!client || !checking) return;
    try {
      await client.checkGoal(checking.id, checking.status, checking.notes || undefined);
      setChecking(null);
      await load();
      if (selected) {
        const d = await client.fetchGoalDetail(selected.id);
        setCheckpoints(d?.checkpoints ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function setStatus(id: string, status: string) {
    if (!client) return;
    try { await client.updateGoal(id, { status: status as any }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">🎯 Ziele</h1>
          <p className="text-sm text-gray-500">Persistente Vorhaben. Alfred checked sie nach der Cadence und generiert Insights bei Drift.</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded">+ Neues Ziel</button>
      </div>

      <div className="flex gap-2">
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-1.5 text-sm text-gray-200">
          <option value="all">Alle</option>
          <option value="active">Aktiv</option>
          <option value="paused">Pausiert</option>
          <option value="achieved">Erreicht</option>
          <option value="abandoned">Aufgegeben</option>
        </select>
        <div className="flex-1" />
        <button onClick={load} className="text-sm text-blue-400 hover:text-blue-300">↻ Neu laden</button>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-sm text-red-400">{error}</div>}
      {loading && <div className="text-gray-500 text-sm">Lade …</div>}

      {!loading && goals.length === 0 && (
        <div className="border border-dashed border-[#2a2a2a] rounded p-10 text-center text-gray-500 text-sm">
          Noch keine Ziele. Erstes Ziel über den Button anlegen oder Alfred sagen "ich möchte X" — er extrahiert wöchentlich.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {goals.map(g => {
          const overdue = g.lastCheckedAt
            ? Math.round((Date.now() - new Date(g.lastCheckedAt).getTime()) / 86400_000) > g.checkFrequencyDays
            : true;
          return (
            <div
              key={g.id}
              onClick={() => setSelected(selected?.id === g.id ? null : g)}
              className={clsx(
                'bg-[#111] border rounded-lg p-4 cursor-pointer transition-colors',
                selected?.id === g.id ? 'border-blue-500' : 'border-[#1f1f1f] hover:border-[#2a2a2a]',
              )}
            >
              <div className="flex items-start gap-2 justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                    <span className={clsx('px-1.5 py-0.5 rounded border', STATUS_COLOR[g.status])}>{g.status}</span>
                    {g.category && <span className="text-gray-500">{g.category}</span>}
                    {g.cadence && <span className="text-gray-500">· {g.cadence}</span>}
                  </div>
                  <h3 className="text-base font-semibold text-gray-100 truncate">{g.title}</h3>
                  {g.targetMetric && <div className="text-xs text-gray-400 mt-1">🎯 {g.targetMetric}</div>}
                </div>
                {g.status === 'active' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setChecking({ id: g.id, status: 'on-track', notes: '' }); }}
                    className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded shrink-0"
                  >✓ Check</button>
                )}
              </div>
              <div className="flex items-center gap-3 mt-2 text-[11px] text-gray-500">
                <span>Check alle {g.checkFrequencyDays}d</span>
                <span>·</span>
                {g.lastCheckedAt ? (
                  <span>
                    Letzter Check: <span className={CHECK_COLOR[g.lastStatus ?? ''] ?? ''}>{g.lastStatus ?? '—'}</span> · {g.lastCheckedAt.slice(0, 10)}
                  </span>
                ) : (
                  <span className="text-amber-400">noch kein Check</span>
                )}
                {g.status === 'active' && overdue && <span className="text-amber-400 ml-auto">⚠️ überfällig</span>}
              </div>
              {selected?.id === g.id && (
                <div className="mt-3 pt-3 border-t border-[#1f1f1f] space-y-2">
                  {g.description && <p className="text-sm text-gray-300">{g.description}</p>}
                  <div className="flex flex-wrap gap-1">
                    {g.status === 'active' && (
                      <button onClick={(e) => { e.stopPropagation(); setStatus(g.id, 'paused'); }} className="px-2 py-1 text-[10px] border border-amber-500/40 text-amber-400 rounded">Pausieren</button>
                    )}
                    {g.status === 'paused' && (
                      <button onClick={(e) => { e.stopPropagation(); setStatus(g.id, 'active'); }} className="px-2 py-1 text-[10px] border border-blue-500/40 text-blue-400 rounded">Reaktivieren</button>
                    )}
                    {g.status !== 'achieved' && (
                      <button onClick={(e) => { e.stopPropagation(); setStatus(g.id, 'achieved'); }} className="px-2 py-1 text-[10px] border border-emerald-500/40 text-emerald-400 rounded">Erreicht</button>
                    )}
                    {g.status !== 'abandoned' && (
                      <button onClick={(e) => { e.stopPropagation(); setStatus(g.id, 'abandoned'); }} className="px-2 py-1 text-[10px] border border-zinc-500/40 text-zinc-400 rounded">Aufgeben</button>
                    )}
                  </div>
                  {checkpoints.length > 0 && (
                    <div className="mt-2">
                      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Checkpoints</div>
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {checkpoints.map(c => (
                          <div key={c.id} className="text-[11px] text-gray-400">
                            <span className={CHECK_COLOR[c.status ?? ''] ?? ''}>{c.status ?? '—'}</span> · {c.checkedAt.slice(0, 16)}
                            {c.notes && <span className="text-gray-500"> · {c.notes.slice(0, 80)}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#111] border border-[#1f1f1f] rounded-xl p-6 w-full max-w-md space-y-3">
            <h3 className="text-lg font-semibold text-white">Neues Ziel</h3>
            <input
              placeholder="Titel"
              value={newGoal.title ?? ''}
              onChange={(e) => setNewGoal(p => ({ ...p, title: e.target.value }))}
              className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200"
            />
            <textarea
              placeholder="Beschreibung (optional)"
              value={newGoal.description ?? ''}
              onChange={(e) => setNewGoal(p => ({ ...p, description: e.target.value }))}
              rows={3}
              className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200"
            />
            <div className="grid grid-cols-2 gap-2">
              <select value={newGoal.category ?? ''} onChange={(e) => setNewGoal(p => ({ ...p, category: e.target.value }))} className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200">
                <option value="">Kategorie …</option>
                <option value="fitness">Fitness</option>
                <option value="finance">Finance</option>
                <option value="relationships">Relationships</option>
                <option value="work">Work</option>
                <option value="health">Health</option>
                <option value="learning">Learning</option>
                <option value="home">Home</option>
                <option value="other">Other</option>
              </select>
              <select value={newGoal.cadence ?? ''} onChange={(e) => setNewGoal(p => ({ ...p, cadence: e.target.value }))} className="bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200">
                <option value="">Cadence …</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="one-time">One-time</option>
              </select>
            </div>
            <input
              placeholder="Target Metric (z.B. '2x/Woche Sport')"
              value={newGoal.targetMetric ?? ''}
              onChange={(e) => setNewGoal(p => ({ ...p, targetMetric: e.target.value }))}
              className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200"
            />
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400">Check alle (Tage):</label>
              <input
                type="number" min={1} max={365}
                value={newGoal.checkFrequencyDays ?? 7}
                onChange={(e) => setNewGoal(p => ({ ...p, checkFrequencyDays: Number(e.target.value) }))}
                className="w-20 bg-[#0a0a0a] border border-[#1f1f1f] rounded px-2 py-1 text-sm text-gray-200"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => { setShowAdd(false); setNewGoal({}); }} className="px-3 py-1.5 text-sm text-gray-400">Abbrechen</button>
              <button onClick={handleAdd} disabled={!newGoal.title?.trim()} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded">Anlegen</button>
            </div>
          </div>
        </div>
      )}

      {checking && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setChecking(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-[#111] border border-[#1f1f1f] rounded-xl p-6 w-full max-w-md space-y-3">
            <h3 className="text-lg font-semibold text-white">Checkpoint loggen</h3>
            <div className="flex gap-1">
              {['on-track', 'drifting', 'achieved', 'no-data'].map(s => (
                <button
                  key={s}
                  onClick={() => setChecking(c => c ? { ...c, status: s } : null)}
                  className={clsx(
                    'px-3 py-1.5 text-xs rounded border',
                    checking.status === s ? 'border-blue-500 bg-blue-500/15 text-blue-300' : 'border-[#2a2a2a] text-gray-400',
                  )}
                >{s}</button>
              ))}
            </div>
            <textarea
              placeholder="Notiz (optional)"
              value={checking.notes}
              onChange={(e) => setChecking(c => c ? { ...c, notes: e.target.value } : null)}
              rows={3}
              className="w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setChecking(null)} className="px-3 py-1.5 text-sm text-gray-400">Abbrechen</button>
              <button onClick={handleCheck} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded">Loggen</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
