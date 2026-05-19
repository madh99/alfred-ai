'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ProjectAgentSession } from '@/lib/alfred-client';

const PHASE_BADGES: Record<string, string> = {
  planning: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
  coding: 'bg-purple-500/20 text-purple-400 border-purple-500/40',
  building: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
  fixing: 'bg-orange-500/20 text-orange-400 border-orange-500/40',
  done: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
  failed: 'bg-red-500/20 text-red-400 border-red-500/40',
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

export function ProjectAgentsPage() {
  const { client } = useConfig();
  const [sessions, setSessions] = useState<ProjectAgentSession[]>([]);
  const [selected, setSelected] = useState<ProjectAgentSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterPhase, setFilterPhase] = useState<string>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(null);
    try {
      const list = await client.fetchProjectAgents(filterPhase === 'all' ? undefined : { phase: filterPhase });
      setSessions(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, filterPhase]);

  useEffect(() => { load(); }, [load]);

  // Re-fetch every 10s while at least one non-terminal session is visible
  useEffect(() => {
    const hasRunning = sessions.some(s => s.currentPhase !== 'done' && s.currentPhase !== 'failed');
    if (!hasRunning) return;
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [sessions, load]);

  async function handleStop(taskId: string) {
    if (!client) return;
    if (!confirm('Diese Project-Agent-Session wirklich stoppen?')) return;
    const ok = await client.stopProjectAgent(taskId);
    if (ok) {
      await load();
    } else {
      alert('Stop fehlgeschlagen.');
    }
  }

  const filtered = sessions.filter(s => {
    if (!search) return true;
    const lower = search.toLowerCase();
    return s.goal.toLowerCase().includes(lower)
      || s.cwd.toLowerCase().includes(lower)
      || s.taskId.toLowerCase().includes(lower);
  });

  return (
    <div className="flex h-full">
      {/* List */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-100">Project Agents</h1>
            <p className="text-sm text-gray-500">Verlauf aller Project-Agent-Sessions (laufend + abgeschlossen + fehlgeschlagen)</p>
          </div>
          <button
            onClick={load}
            className="px-3 py-1.5 bg-blue-500/10 text-blue-400 border border-blue-500/40 rounded text-sm hover:bg-blue-500/20"
          >
            Neu laden
          </button>
        </div>

        <div className="flex gap-2 mb-4">
          <select
            value={filterPhase}
            onChange={e => setFilterPhase(e.target.value)}
            className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-3 py-1.5 text-sm text-gray-200"
          >
            <option value="all">Alle Phasen</option>
            <option value="planning">Planning</option>
            <option value="coding">Coding</option>
            <option value="building">Building</option>
            <option value="fixing">Fixing</option>
            <option value="done">Done</option>
            <option value="failed">Failed</option>
          </select>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Suche in goal, cwd, taskId…"
            className="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500"
          />
        </div>

        {loading && <div className="text-gray-500 text-sm">Lade…</div>}
        {error && <div className="text-red-400 text-sm">Fehler: {error}</div>}

        {!loading && filtered.length === 0 && (
          <div className="text-gray-500 text-sm border border-dashed border-[#2a2a2a] rounded p-8 text-center">
            Keine Sessions {filterPhase !== 'all' && `mit Phase "${filterPhase}"`}.
          </div>
        )}

        <div className="space-y-2">
          {filtered.map(s => {
            const phaseBadge = PHASE_BADGES[s.currentPhase] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/40';
            const buildIcon = s.lastBuildPassed ? '✅' : (s.currentPhase === 'failed' ? '🔴' : '⏳');
            const isSelected = selected?.taskId === s.taskId;
            return (
              <div
                key={s.taskId}
                onClick={() => setSelected(s)}
                className={`p-3 border rounded cursor-pointer transition-colors ${
                  isSelected
                    ? 'border-blue-500/60 bg-blue-500/5'
                    : 'border-[#2a2a2a] bg-[#141414] hover:border-[#3a3a3a]'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className={`text-xs px-1.5 py-0.5 rounded border ${phaseBadge}`}>{s.currentPhase}</span>
                    <span className="text-xs text-gray-500">{buildIcon}</span>
                    <span className="text-sm text-gray-200 truncate">{s.goal.slice(0, 100)}</span>
                  </div>
                  <span className="text-xs text-gray-500 shrink-0">{relativeTime(s.lastProgressAt ?? s.updatedAt)} ago</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <span className="font-mono">{s.cwd}</span>
                  <span>·</span>
                  <span>iter {s.currentIteration}</span>
                  <span>·</span>
                  <span>{s.totalFilesChanged} files</span>
                  <span>·</span>
                  <span className="font-mono">{s.agentName}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail */}
      {selected && (
        <div className="w-[480px] border-l border-[#1f1f1f] bg-[#0f0f0f] overflow-y-auto p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-100">Session Detail</h2>
            <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-gray-300">×</button>
          </div>

          <div className="space-y-4 text-sm">
            <div>
              <div className="text-xs text-gray-500 mb-1">Task ID</div>
              <div className="font-mono text-xs text-gray-300 break-all">{selected.taskId}</div>
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-1">Ziel</div>
              <div className="text-gray-200 whitespace-pre-wrap">{selected.goal}</div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-gray-500 mb-1">Phase</div>
                <span className={`inline-block text-xs px-1.5 py-0.5 rounded border ${PHASE_BADGES[selected.currentPhase] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/40'}`}>
                  {selected.currentPhase}
                </span>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Build</div>
                <div className="text-gray-200">{selected.lastBuildPassed ? '✅ passed' : '🔴 not passed'}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Iteration</div>
                <div className="text-gray-200">{selected.currentIteration}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Files changed</div>
                <div className="text-gray-200">{selected.totalFilesChanged}</div>
              </div>
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-1">Working Directory</div>
              <div className="font-mono text-xs text-gray-300 break-all">{selected.cwd}</div>
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-1">Agent</div>
              <div className="font-mono text-xs text-gray-300">{selected.agentName}</div>
            </div>

            {selected.lastCommitSha && (
              <div>
                <div className="text-xs text-gray-500 mb-1">Last commit SHA</div>
                <div className="font-mono text-xs text-gray-300">{selected.lastCommitSha.slice(0, 12)}</div>
              </div>
            )}

            {selected.milestones.length > 0 && (
              <div>
                <div className="text-xs text-gray-500 mb-1">Milestones ({selected.milestones.length})</div>
                <ul className="text-xs text-gray-400 space-y-1 max-h-60 overflow-y-auto">
                  {selected.milestones.map((m, i) => (
                    <li key={i} className="border-l-2 border-[#2a2a2a] pl-2">{m}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 pt-2 text-xs">
              <div>
                <div className="text-gray-500 mb-1">Created</div>
                <div className="text-gray-400">{new Date(selected.createdAt).toLocaleString('de-DE')}</div>
              </div>
              <div>
                <div className="text-gray-500 mb-1">Updated</div>
                <div className="text-gray-400">{new Date(selected.updatedAt).toLocaleString('de-DE')}</div>
              </div>
            </div>

            {(selected.currentPhase !== 'done' && selected.currentPhase !== 'failed') && (
              <button
                onClick={() => handleStop(selected.taskId)}
                className="w-full mt-4 px-3 py-2 bg-red-500/10 text-red-400 border border-red-500/40 rounded text-sm hover:bg-red-500/20"
              >
                Session stoppen
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
