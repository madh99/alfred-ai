'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ProjectOpenItem } from '@/lib/alfred-client';
import { CodeRunLivePanel } from './CodeRunLivePanel';

interface Props {
  projectId: string;
  projectName: string;
}

function priorityIcon(p: string): string {
  return p === 'high' ? '🔴' : p === 'low' ? '⚪' : '🟡';
}

function statusBadge(s: string): string {
  return ({
    open: 'bg-gray-500/15 text-gray-300 border-gray-500/30',
    in_progress: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
    done: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    cancelled: 'bg-red-500/10 text-red-300/60 border-red-500/20',
  } as Record<string, string>)[s] ?? 'bg-gray-500/15 text-gray-400 border-gray-500/30';
}

/**
 * v663a — Roadmap-View: Open-Items mit roadmap_milestone gesetzt, gruppiert
 * nach Milestone. Pro Milestone „⚡ Implementieren"-Button startet Project-Agent.
 */
export function ProjectRoadmapView({ projectId, projectName }: Props) {
  const { client } = useConfig();
  const [milestones, setMilestones] = useState<Record<string, ProjectOpenItem[]>>({});
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [implementing, setImplementing] = useState<string | null>(null);
  // v898 — Milestones nachträglich zu EINEM Feature zusammenführen (Re-Tag)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [combineName, setCombineName] = useState('');
  const [withPlan, setWithPlan] = useState(true);
  const [consolidating, setConsolidating] = useState(false);
  // v898 — CLI-Picker für den optionalen Plan-Lauf ('' = Automatisch/Projekt-Strategie)
  const [agents, setAgents] = useState<string[]>([]);
  const [consolidateAgent, setConsolidateAgent] = useState('');
  // v898.2 — Live-Output des Konsolidierungs-Plan-Laufs (vorher unsichtbar)
  const [runTaskId, setRunTaskId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const data = await client.fetchProjectRoadmap(projectId);
      setMilestones(data);
    } finally {
      setLoading(false);
    }
  }, [client, projectId]);

  useEffect(() => { if (expanded) load(); }, [expanded, load]);
  // v898 — verfügbare CLI-Agents für den Plan-Picker laden (einmalig beim Aufklappen)
  useEffect(() => {
    if (!expanded || !client) return;
    void client.fetchCodeAgents().then(setAgents).catch(() => setAgents([]));
  }, [expanded, client]);

  async function implement(milestone: string) {
    if (!client) return;
    const items = milestones[milestone] ?? [];
    const openCount = items.filter(i => i.status === 'open' || i.status === 'in_progress').length;
    if (openCount === 0) {
      alert(`Keine offenen Items in Milestone "${milestone}".`);
      return;
    }
    if (!confirm(`Project-Agent für ${openCount} Items in Milestone "${milestone}" starten?`)) return;
    setImplementing(milestone);
    try {
      const r = await client.implementMilestone(projectId, milestone);
      if (r.ok && r.taskId) {
        setRunTaskId(r.taskId); // v898.2 — Live-Output statt blindem Alert
      } else if (r.ok) {
        alert(`▶ Project-Agent gestartet (${r.itemCount} Items).`);
      } else {
        alert(`Fehler: ${r.error}`);
      }
    } finally {
      setImplementing(null);
    }
  }

  function toggleSelected(ms: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(ms)) next.delete(ms); else next.add(ms);
      return next;
    });
  }

  async function consolidate() {
    if (!client || selected.size < 2) return;
    const list = Array.from(selected);
    const msg = withPlan
      ? `${list.length} Milestones zu EINEM Feature zusammenführen?\n\nDie Items behalten ihren Fortschritt und werden umgehängt. Anschließend arbeitet ein Agent einen konsolidierten Plan aus und ergänzt fehlende Lücken-Items.`
      : `${list.length} Milestones zu EINEM Feature zusammenführen?\n\nDie Items behalten ihren Fortschritt und werden nur umgehängt (kein Agent-Lauf).`;
    if (!confirm(msg)) return;
    setConsolidating(true);
    try {
      const r = await client.projectConsolidateMilestones(projectId, {
        milestones: list,
        name: combineName.trim() || undefined,
        withPlan,
        agent: withPlan ? (consolidateAgent || undefined) : undefined,
      });
      if (r.ok) {
        setSelected(new Set());
        setCombineName('');
        load();
        if (r.planned && r.liveTaskId) {
          // Plan-Lauf läuft im Hintergrund → Live-Output anzeigen (statt blindem Alert)
          setRunTaskId(r.liveTaskId);
        } else {
          alert(`🧩 ${r.retagged} Items zu „${r.milestone}" zusammengeführt (nur umgehängt — kein Plan-Lauf).`);
        }
      } else {
        alert(`Fehler: ${r.reason}`);
      }
    } finally {
      setConsolidating(false);
    }
  }

  const sortedMilestones = Object.keys(milestones).sort();
  const totalItems = Object.values(milestones).reduce((s, arr) => s + arr.length, 0);

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button
          onClick={() => setExpanded(true)}
          className="w-full text-left flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200"
        >
          <span>▸</span>
          <span>🗺️ Roadmap</span>
          <span className="text-[10px] text-gray-600 font-normal">— Milestones + Implementier-Aktion</span>
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
          <span>🗺️ Roadmap — {projectName}</span>
          {totalItems > 0 && <span className="text-[10px] text-gray-600">({totalItems} Items)</span>}
        </button>
        <button onClick={load} disabled={loading} className="text-[10px] text-gray-500 hover:text-blue-400 px-2 py-0.5 rounded border border-[#1f1f1f]">↻</button>
      </div>

      {/* v898.2 — Live-Output des Konsolidierungs-Plan-Laufs (Plan-Doc + Lücken-Analyse) */}
      {runTaskId && client && (
        <div className="mb-3">
          <CodeRunLivePanel
            client={client}
            taskId={runTaskId}
            onEnded={() => load()}
            onClose={() => setRunTaskId(null)}
          />
        </div>
      )}

      {loading && <div className="text-xs text-gray-500 italic">Lade…</div>}
      {!loading && sortedMilestones.length === 0 && (
        <div className="text-xs text-gray-600 italic bg-[#0f0f0f] border border-dashed border-[#222] rounded p-3 text-center">
          Keine Roadmap-Items. Füge einem Open-Item ein <span className="font-mono">roadmap_milestone</span> hinzu
          (z.B. „v2.0", „Beta", „Q3-2026") damit es hier erscheint.
        </div>
      )}

      {/* v898 — Konsolidierungs-Aktionsleiste (ab 2 ausgewählten Milestones) */}
      {selected.size >= 2 && (
        <div className="mb-3 bg-[#0f1420] border border-blue-500/30 rounded p-2.5 space-y-2">
          <div className="text-[11px] text-blue-200 flex items-center gap-1.5">
            <span>🧩</span>
            <span>{selected.size} Milestones zu EINEM Feature zusammenführen</span>
          </div>
          <input
            type="text"
            value={combineName}
            onChange={e => setCombineName(e.target.value)}
            placeholder="Name des gemeinsamen Features (optional)"
            className="w-full text-xs bg-[#0a0a0a] border border-[#222] rounded px-2 py-1 text-gray-200"
          />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <label className="text-[10px] text-gray-400 flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={withPlan} onChange={e => setWithPlan(e.target.checked)} />
              <span>Plan-Doc + Lücken-Analyse durch Agent (sonst nur umhängen)</span>
            </label>
            {withPlan && (
              <label className="text-[10px] text-gray-400 flex items-center gap-1.5">
                <span>CLI:</span>
                <select
                  value={consolidateAgent}
                  onChange={e => setConsolidateAgent(e.target.value)}
                  className="text-[10px] bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-0.5 text-gray-200"
                  title="CLI-Agent für den Plan-Lauf — Automatisch nutzt die Projekt-Strategie (preferred)"
                >
                  <option value="">Automatisch (Strategie)</option>
                  {agents.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
            )}
            <div className="flex gap-1.5">
              <button onClick={() => setSelected(new Set())} className="text-[10px] px-2 py-1 text-gray-400 hover:text-gray-200 rounded border border-[#222]">Abbrechen</button>
              <button
                onClick={consolidate}
                disabled={consolidating}
                className="text-[10px] px-2.5 py-1 bg-blue-600/30 border border-blue-500/50 text-blue-200 rounded hover:bg-blue-600/50 disabled:opacity-40"
              >{consolidating ? '⏳ Führe zusammen…' : `🧩 Zu einem Feature zusammenführen (${selected.size})`}</button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {sortedMilestones.map(ms => {
          const items = milestones[ms];
          const openCount = items.filter(i => i.status === 'open' || i.status === 'in_progress').length;
          const doneCount = items.filter(i => i.status === 'done').length;
          const totalHours = items.reduce((s, i) => s + (i.estimatedHours ?? 0), 0);
          return (
            <div key={ms} className={`bg-[#0f0f0f] border rounded ${selected.has(ms) ? 'border-blue-500/50' : 'border-[#222]'}`}>
              {/* Milestone-Header */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-[#222]">
                <input
                  type="checkbox"
                  checked={selected.has(ms)}
                  onChange={() => toggleSelected(ms)}
                  title="Für Zusammenführung auswählen"
                  className="cursor-pointer"
                />
                <span className="font-semibold text-blue-300">{ms}</span>
                <span className="text-[10px] text-gray-500">{openCount} offen · {doneCount} fertig · {items.length} gesamt{totalHours > 0 ? ` · ~${totalHours}h` : ''}</span>
                <div className="flex-1" />
                <button
                  onClick={() => implement(ms)}
                  disabled={implementing === ms || openCount === 0}
                  className="px-2 py-0.5 text-[10px] bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 rounded hover:bg-emerald-600/40 disabled:opacity-40"
                  title={openCount === 0 ? 'Keine offenen Items in diesem Milestone' : `Project-Agent für ${openCount} offene Items starten`}
                >{implementing === ms ? '⏳ Starte…' : '⚡ Implementieren'}</button>
              </div>
              {/* Items */}
              <div className="divide-y divide-[#1a1a1a]">
                {items.map(it => (
                  <div key={it.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${statusBadge(it.status)}`}>{it.status}</span>
                    <span>{priorityIcon(it.priority)}</span>
                    <span className={`flex-1 ${it.status === 'done' ? 'line-through text-gray-500' : it.status === 'cancelled' ? 'text-gray-600' : 'text-gray-300'}`}>{it.title}</span>
                    {it.estimatedHours != null && (
                      <span className="text-[10px] text-gray-500">~{it.estimatedHours}h</span>
                    )}
                    <span className="text-[10px] text-gray-600 font-mono">#{it.roadmapOrder ?? '–'}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
