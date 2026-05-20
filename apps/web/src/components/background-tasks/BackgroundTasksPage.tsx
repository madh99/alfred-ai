'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { BackgroundTaskItem, BackgroundTaskStatus } from '@/lib/alfred-client';

const STATUS_BADGES: Record<string, string> = {
  pending: 'bg-gray-500/20 text-gray-400 border-gray-500/40',
  running: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
  resuming: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40',
  checkpointed: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
  completed: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
  failed: 'bg-red-500/20 text-red-400 border-red-500/40',
  cancelled: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/40',
};

function relativeTime(iso?: string): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function durationOf(task: BackgroundTaskItem): string {
  if (!task.startedAt) return '—';
  const end = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
  const ms = end - new Date(task.startedAt).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000 * 10) / 10}h`;
}

export function BackgroundTasksPage() {
  const { client } = useConfig();
  const [tasks, setTasks] = useState<BackgroundTaskItem[]>([]);
  const [selected, setSelected] = useState<BackgroundTaskItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const list = await client.fetchBackgroundTasks(filterStatus === 'all' ? undefined : { status: filterStatus });
      setTasks(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, filterStatus]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 10s while any task is in a live state
  useEffect(() => {
    const hasLive = tasks.some(t =>
      t.status === 'running' || t.status === 'pending' || t.status === 'resuming' || t.status === 'checkpointed',
    );
    if (!hasLive) return;
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [tasks, load]);

  async function handleCancel(id: string) {
    if (!client) return;
    if (!confirm('Diesen Background-Task wirklich abbrechen?')) return;
    const ok = await client.cancelBackgroundTask(id);
    if (ok) await load();
    else alert('Cancel fehlgeschlagen — Task ist nicht (mehr) in cancelbarem Zustand.');
  }

  const filtered = tasks.filter(t => {
    if (!search) return true;
    const lower = search.toLowerCase();
    return t.description.toLowerCase().includes(lower)
      || t.skillName.toLowerCase().includes(lower)
      || t.id.toLowerCase().includes(lower)
      || (t.error ?? '').toLowerCase().includes(lower);
  });

  // Compact selectable status options
  const statusOptions: Array<{ value: string; label: string }> = [
    { value: 'all', label: 'Alle' },
    { value: 'pending', label: 'Pending' },
    { value: 'running', label: 'Running' },
    { value: 'checkpointed', label: 'Checkpointed' },
    { value: 'resuming', label: 'Resuming' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' },
    { value: 'cancelled', label: 'Cancelled' },
  ];

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-100">Background Tasks</h1>
            <p className="text-sm text-gray-500">Persistente und async Skill-Tasks (Recovery, langlaufende shell-/deploy-Aufgaben)</p>
          </div>
          <button
            onClick={load}
            className="px-3 py-1.5 bg-blue-500/10 text-blue-400 border border-blue-500/40 rounded text-sm hover:bg-blue-500/20"
          >
            Neu laden
          </button>
        </div>

        <div className="flex gap-2 mb-4 flex-wrap">
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-3 py-1.5 text-sm text-gray-200"
          >
            {statusOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Suche in description, skill, id, error…"
            className="flex-1 min-w-48 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500"
          />
        </div>

        {loading && tasks.length === 0 && <div className="text-gray-500 text-sm">Lade…</div>}
        {error && <div className="text-red-400 text-sm">Fehler: {error}</div>}

        {!loading && filtered.length === 0 && (
          <div className="text-gray-500 text-sm border border-dashed border-[#2a2a2a] rounded p-8 text-center">
            Keine Tasks {filterStatus !== 'all' && `im Status "${filterStatus}"`}.
          </div>
        )}

        <div className="space-y-2">
          {filtered.map(t => {
            const badge = STATUS_BADGES[t.status] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/40';
            const isSelected = selected?.id === t.id;
            const hasCheckpoint = Boolean(t.agentState);
            return (
              <div
                key={t.id}
                onClick={() => setSelected(t)}
                className={`p-3 border rounded cursor-pointer transition-colors ${
                  isSelected
                    ? 'border-blue-500/60 bg-blue-500/5'
                    : 'border-[#2a2a2a] bg-[#141414] hover:border-[#3a3a3a]'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className={`text-xs px-1.5 py-0.5 rounded border ${badge}`}>{t.status}</span>
                    {hasCheckpoint && <span className="text-xs text-amber-400" title="Hat Checkpoint — recoverable">⚓</span>}
                    {t.resumeCount > 0 && <span className="text-xs text-cyan-400" title={`${t.resumeCount}× resumed`}>↻{t.resumeCount}</span>}
                    <span className="text-sm text-gray-200 truncate">{t.description.slice(0, 120)}</span>
                  </div>
                  <span className="text-xs text-gray-500 shrink-0">{relativeTime(t.completedAt ?? t.startedAt ?? t.createdAt)} ago</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <span className="font-mono">{t.skillName}</span>
                  <span>·</span>
                  <span>{durationOf(t)}</span>
                  {t.error && (
                    <>
                      <span>·</span>
                      <span className="text-red-400 truncate max-w-md">{t.error.slice(0, 100)}</span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selected && (
        <div className="w-[480px] border-l border-[#1f1f1f] bg-[#0f0f0f] overflow-y-auto p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-100">Task Detail</h2>
            <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-gray-300">×</button>
          </div>

          <div className="space-y-4 text-sm">
            <div>
              <div className="text-xs text-gray-500 mb-1">Task ID</div>
              <div className="font-mono text-xs text-gray-300 break-all">{selected.id}</div>
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-1">Status</div>
              <span className={`inline-block text-xs px-1.5 py-0.5 rounded border ${STATUS_BADGES[selected.status] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/40'}`}>
                {selected.status}
              </span>
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-1">Beschreibung</div>
              <div className="text-gray-200 whitespace-pre-wrap">{selected.description}</div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-gray-500 mb-1">Skill</div>
                <div className="font-mono text-xs text-gray-300">{selected.skillName}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Dauer</div>
                <div className="text-gray-200">{durationOf(selected)}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Resume Count</div>
                <div className="text-gray-200">{selected.resumeCount}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Checkpoint</div>
                <div className="text-gray-200">{selected.agentState ? '⚓ vorhanden' : '— keiner'}</div>
              </div>
            </div>

            {selected.maxDurationHours != null && (
              <div>
                <div className="text-xs text-gray-500 mb-1">Max Duration</div>
                <div className="text-gray-200">{selected.maxDurationHours}h</div>
              </div>
            )}

            <div>
              <div className="text-xs text-gray-500 mb-1">Skill Input (raw)</div>
              <pre className="text-xs text-gray-400 font-mono bg-[#0a0a0a] border border-[#2a2a2a] rounded p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">{selected.skillInput}</pre>
            </div>

            {selected.error && (
              <div>
                <div className="text-xs text-gray-500 mb-1">Error</div>
                <pre className="text-xs text-red-300 font-mono bg-[#1a0a0a] border border-red-900/40 rounded p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">{selected.error}</pre>
              </div>
            )}

            {selected.result && (
              <div>
                <div className="text-xs text-gray-500 mb-1">Result</div>
                <pre className="text-xs text-emerald-300 font-mono bg-[#0a1a0a] border border-emerald-900/40 rounded p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">{selected.result.slice(0, 1000)}</pre>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 pt-2 text-xs">
              <div>
                <div className="text-gray-500 mb-1">Created</div>
                <div className="text-gray-400">{new Date(selected.createdAt).toLocaleString('de-DE')}</div>
              </div>
              {selected.startedAt && (
                <div>
                  <div className="text-gray-500 mb-1">Started</div>
                  <div className="text-gray-400">{new Date(selected.startedAt).toLocaleString('de-DE')}</div>
                </div>
              )}
              {selected.checkpointAt && (
                <div>
                  <div className="text-gray-500 mb-1">Checkpoint</div>
                  <div className="text-gray-400">{new Date(selected.checkpointAt).toLocaleString('de-DE')}</div>
                </div>
              )}
              {selected.completedAt && (
                <div>
                  <div className="text-gray-500 mb-1">Completed</div>
                  <div className="text-gray-400">{new Date(selected.completedAt).toLocaleString('de-DE')}</div>
                </div>
              )}
            </div>

            {(selected.status === 'pending' || selected.status === 'running') && (
              <button
                onClick={() => handleCancel(selected.id)}
                className="w-full mt-4 px-3 py-2 bg-red-500/10 text-red-400 border border-red-500/40 rounded text-sm hover:bg-red-500/20"
              >
                Task abbrechen
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
