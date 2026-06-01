'use client';

import { useEffect, useState, useCallback } from 'react';
import type {
  AlfredClient,
  SandboxItem,
  ProjectAgentSession,
} from '../../lib/alfred-client';

interface Props {
  client: AlfredClient;
  projectId: string;
  projectCwd: string;
}

/**
 * v842 — Live-Indikator auf der Project-Detail-Karte.
 * Zeigt nur dann etwas wenn für DIESES Projekt gerade was läuft:
 * - aktive Sandboxes (creating/running/paused/merging)
 * - aktive Plan-Agent-Sessions (cwd matched project.cwd)
 *
 * Klick auf eine Karte navigiert zur jeweiligen Detail-Page.
 * Polling alle 5s. Wenn nichts aktiv: Komponente returnt null (kein Platzverbrauch).
 *
 * Nicht abgedeckt (out-of-scope für v842):
 * - Quick-Code-Agent OHNE Sandbox (via Telegram-Chat) — läuft fire-and-forget,
 *   nicht persistent getrackt. Separater Tracking-Mechanismus wäre v843+.
 */
export function ProjectActiveIndicator({ client, projectId, projectCwd }: Props) {
  const [sandboxes, setSandboxes] = useState<SandboxItem[]>([]);
  const [planAgents, setPlanAgents] = useState<ProjectAgentSession[]>([]);

  const load = useCallback(async () => {
    if (!projectCwd) return;
    try {
      // Sandboxes pro Projekt
      const sbList = await client.listSandboxes({ projectId });
      const activeStates = new Set(['creating', 'running', 'paused', 'merging']);
      const activeSb = sbList.filter(s => activeStates.has(s.status));
      setSandboxes(activeSb);
    } catch { /* non-critical */ }
    try {
      // Plan-Agent-Sessions strict gefiltert auf project.cwd
      const all = await client.fetchProjectAgents();
      const active = all.filter(s => {
        const phaseActive = s.currentPhase !== 'done' && s.currentPhase !== 'failed' && s.currentPhase !== 'aborted';
        const cwdMatches = s.cwd === projectCwd || (projectCwd && s.cwd?.startsWith(projectCwd + '/'));
        return phaseActive && cwdMatches;
      });
      setPlanAgents(active);
    } catch { /* non-critical */ }
  }, [client, projectId, projectCwd]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);

  const totalActive = sandboxes.length + planAgents.length;
  if (totalActive === 0) return null;

  function formatDuration(iso: string | null | undefined): string {
    if (!iso) return '';
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  return (
    <div className="bg-emerald-500/5 border border-emerald-500/30 rounded-lg p-3 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-xs font-semibold text-emerald-300">
          🔴 LIVE · {sandboxes.length > 0 && `${sandboxes.length} Sandbox${sandboxes.length > 1 ? 'es' : ''}`}
          {sandboxes.length > 0 && planAgents.length > 0 && ' · '}
          {planAgents.length > 0 && `${planAgents.length} Plan-Agent${planAgents.length > 1 ? 's' : ''}`}
        </span>
      </div>
      <div className="space-y-1">
        {sandboxes.map(s => (
          <a
            key={s.id}
            href={`/interactive?sandbox=${encodeURIComponent(s.id)}`}
            className="block bg-[#0a0a0a] hover:bg-emerald-500/10 border border-[#1f1f1f] hover:border-emerald-500/40 rounded px-2 py-1.5 text-[11px] transition-colors"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 bg-cyan-500/15 text-cyan-300 rounded font-mono">🧪 {s.status}</span>
              <span className="text-gray-200 flex-1 truncate font-mono">{s.branchName}</span>
              {s.projectType && <span className="text-[9px] text-gray-500">{s.projectType}</span>}
              {s.hostPort && <span className="text-[9px] text-gray-500">:{s.hostPort}</span>}
              <span className="text-[9px] text-emerald-400/80 font-mono">{formatDuration(s.lastActiveAt)}</span>
              <span className="text-emerald-400/60">→</span>
            </div>
          </a>
        ))}
        {planAgents.map(s => (
          <a
            key={s.taskId}
            href={`/project-agents?task=${encodeURIComponent(s.taskId)}`}
            className="block bg-[#0a0a0a] hover:bg-emerald-500/10 border border-[#1f1f1f] hover:border-emerald-500/40 rounded px-2 py-1.5 text-[11px] transition-colors"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 bg-emerald-500/15 text-emerald-300 rounded font-mono">🤖 {s.currentPhase}</span>
              <span className="text-gray-200 flex-1 truncate">{s.goal.slice(0, 80)}</span>
              <span className="text-[9px] text-gray-500">iter {s.currentIteration}</span>
              <span className="text-[9px] text-gray-500">{s.totalFilesChanged} files</span>
              {s.lastProgressAt && <span className="text-[9px] text-emerald-400/80 font-mono">{formatDuration(s.lastProgressAt)}</span>}
              <span className="text-emerald-400/60">→</span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
