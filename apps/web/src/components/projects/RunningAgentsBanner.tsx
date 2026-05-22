'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ProjectAgentSession } from '@/lib/alfred-client';

/**
 * v688 — Banner auf der Projekte-Übersicht: zeigt alle aktuell laufenden
 * Project-Agent-Sessions als kleine Karten. Klick navigiert zur
 * /project-agents-Seite mit dem Detail-Pane für die Task-ID offen.
 *
 * Filter: alle Sessions mit currentPhase != 'done' && != 'failed'
 * (also planning, coding, validating, ...).
 *
 * Polling alle 5s damit man Live-Progress sieht ohne Reload.
 */
export function RunningAgentsBanner() {
  const { client } = useConfig();
  const [sessions, setSessions] = useState<ProjectAgentSession[]>([]);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const all = await client.fetchProjectAgents();
      const running = all.filter(s => s.currentPhase !== 'done' && s.currentPhase !== 'failed' && s.currentPhase !== 'aborted');
      setSessions(running);
    } catch { /* non-critical */ }
  }, [client]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);

  if (sessions.length === 0) return null;

  function go(taskId: string) {
    window.location.href = `/project-agents?task=${encodeURIComponent(taskId)}`;
  }

  function formatDuration(iso: string): string {
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m - h * 60}m`;
  }

  return (
    <div className="mb-4 bg-emerald-500/5 border border-emerald-500/30 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          🤖 Aktuell laufend ({sessions.length})
        </div>
        <button
          onClick={load}
          className="text-[10px] text-emerald-400/70 hover:text-emerald-300"
          title="Aktualisieren"
        >↻</button>
      </div>
      <div className="space-y-1">
        {sessions.map(s => {
          const projectFolder = s.cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? '?';
          return (
            <button
              key={s.taskId}
              onClick={() => go(s.taskId)}
              className="w-full text-left bg-[#0a0a0a] hover:bg-emerald-500/10 border border-[#1f1f1f] hover:border-emerald-500/40 rounded px-2 py-1.5 text-xs transition-colors"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-emerald-500/15 text-emerald-300 rounded font-mono">{s.currentPhase}</span>
                <span className="text-gray-200 flex-1 truncate">{s.goal.slice(0, 90)}</span>
                <span className="text-[10px] text-gray-500 shrink-0">{projectFolder}</span>
                <span className="text-[10px] text-gray-500 shrink-0">iter {s.currentIteration}</span>
                <span className="text-[10px] text-gray-500 shrink-0">{s.totalFilesChanged} files</span>
                {s.lastProgressAt && <span className="text-[10px] text-emerald-400/80 shrink-0 font-mono">{formatDuration(s.lastProgressAt)}</span>}
                <span className="text-emerald-400/60">→</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
