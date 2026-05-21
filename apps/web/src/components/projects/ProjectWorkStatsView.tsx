'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ProjectWorkStats } from '@/lib/alfred-client';

interface Props {
  projectId: string;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  if (h < 24) return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h - d * 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function typeLabel(t: string): string {
  return ({
    project_agent: '🤖 Project-Agent',
    code_agent: '⚙️ Code-Agent',
    brainstorming: '💡 Brainstorming',
    delegate: '↪ Delegate',
  } as Record<string, string>)[t] ?? t;
}

/**
 * v658 — Work-Stats: Gesamt-Arbeitszeit aller Sessions pro Projekt, aufgeteilt
 * nach Session-Type und Agent (claude-code, codex, etc.).
 */
export function ProjectWorkStatsView({ projectId }: Props) {
  const { client } = useConfig();
  const [stats, setStats] = useState<ProjectWorkStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const s = await client.fetchProjectWorkStats(projectId);
      setStats(s);
    } finally {
      setLoading(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    if (expanded && !stats) load();
  }, [expanded, stats, load]);

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button
          onClick={() => setExpanded(true)}
          className="w-full text-left flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200"
        >
          <span>▸</span>
          <span>📊 Arbeitszeit-Statistik</span>
          <span className="text-[10px] text-gray-600 font-normal">— byType + byAgent</span>
        </button>
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-[#222]">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setExpanded(false)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200"
        >
          <span>▾</span>
          <span>📊 Arbeitszeit-Statistik</span>
        </button>
        <button
          onClick={load}
          disabled={loading}
          title="Neu laden"
          className="text-[10px] text-gray-500 hover:text-blue-400 px-2 py-0.5 rounded border border-[#1f1f1f]"
        >↻</button>
      </div>

      {!stats && loading && <div className="text-xs text-gray-500 italic">Lade…</div>}
      {stats && (
        <div className="space-y-3">
          {/* Total */}
          <div className="bg-[#0f0f0f] border border-[#222] rounded p-3 grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Gesamtzeit</div>
              <div className="text-base font-semibold text-blue-400">{formatDuration(stats.total.totalSeconds)}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Sessions</div>
              <div className="text-base font-semibold text-gray-200">{stats.total.count}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Laufend</div>
              <div className="text-base font-semibold text-emerald-400">{stats.total.runningCount}</div>
            </div>
          </div>

          {/* byType */}
          {stats.byType.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Nach Typ</div>
              <div className="space-y-0.5">
                {stats.byType.map(t => (
                  <div key={t.sessionType} className="flex items-center gap-2 text-xs">
                    <span className="flex-1 text-gray-300">{typeLabel(t.sessionType)}</span>
                    <span className="text-gray-500 text-[10px]">{t.count} ({t.completedCount} fertig)</span>
                    <span className="font-mono text-blue-400">{formatDuration(t.totalSeconds)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* byAgent */}
          {stats.byAgent.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Nach Agent</div>
              <div className="space-y-0.5">
                {stats.byAgent.map(a => (
                  <div key={a.agent} className="flex items-center gap-2 text-xs">
                    <span className="flex-1 font-mono text-gray-300">{a.agent}</span>
                    <span className="text-gray-500 text-[10px]">{a.count}</span>
                    <span className="font-mono text-blue-400">{formatDuration(a.totalSeconds)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stats.byType.length === 0 && stats.byAgent.length === 0 && (
            <div className="text-xs text-gray-600 italic">Noch keine Sessions registriert.</div>
          )}
        </div>
      )}
    </div>
  );
}
